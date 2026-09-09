// Callable Cloud Functions for CWB account administration.
// All privileged operations require a signed-in caller with the admin custom
// claim AND a TOTP-verified session (second factor present in the ID token).
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

if (!getApps().length) {
  initializeApp();
}
const db = getFirestore();

const ROLES = ['admin', 'manager', 'staff', 'volunteer'];
const FUNCTION_LEVELS = ['operations', 'administration'];

// Reject any caller that is not a fully authenticated, MFA-verified admin.
function requireMfaAdmin(context) {
  if (!context.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const token = context.auth.token || {};
  const isAdmin = token.admin === true || token.role === 'admin';
  const mfaVerified = token.firebase?.sign_in_second_factor === 'totp';
  if (!isAdmin) {
    throw new HttpsError('permission-denied', 'Administrator role required.');
  }
  if (!mfaVerified) {
    throw new HttpsError('failed-precondition', 'Two-factor authentication required.');
  }
}

function assertRoleCombo(role, functionLevel) {
  if (!ROLES.includes(role)) {
    throw new HttpsError('invalid-argument', `Unknown role: ${role}`);
  }
  if (!FUNCTION_LEVELS.includes(functionLevel)) {
    throw new HttpsError('invalid-argument', `Unknown function level: ${functionLevel}`);
  }
  // Volunteers have no Administration responsibilities.
  if (role === 'volunteer' && functionLevel === 'administration') {
    throw new HttpsError('invalid-argument', 'Volunteers cannot be assigned the Administration function.');
  }
}

async function writeUserDoc(uid, data) {
  await db.collection('users').doc(uid).set({
    ...data,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

async function applyClaims(uid, role, functionLevel) {
  const claims = { role, functionLevel };
  if (role === 'admin') {
    claims.admin = true;
  }
  await getAuth().setCustomUserClaims(uid, claims);
}

// Invite (or create) a user by email and assign role + function level.
exports.inviteUser = onCall(async (request) => {
  requireMfaAdmin(request);
  const { email, displayName = '', role, functionLevel } = request.data || {};
  if (!email || typeof email !== 'string') {
    throw new HttpsError('invalid-argument', 'An email address is required.');
  }
  assertRoleCombo(role, functionLevel);

  const auth = getAuth();
  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(email);
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      userRecord = await auth.createUser({ email, displayName, emailVerified: false });
    } else {
      throw error;
    }
  }
  if (displayName && userRecord.displayName !== displayName) {
    await auth.updateUser(userRecord.uid, { displayName });
  }
  await applyClaims(userRecord.uid, role, functionLevel);
  await writeUserDoc(userRecord.uid, {
    email,
    displayName: displayName || userRecord.displayName || '',
    role,
    functionLevel,
    status: 'active',
    createdBy: request.auth.uid,
    createdAt: FieldValue.serverTimestamp()
  });
  return { uid: userRecord.uid, email, role, functionLevel };
});

// Change role/functionLevel for an existing user.
exports.setUserRole = onCall(async (request) => {
  requireMfaAdmin(request);
  const { uid, role, functionLevel } = request.data || {};
  if (!uid) {
    throw new HttpsError('invalid-argument', 'A uid is required.');
  }
  assertRoleCombo(role, functionLevel);
  await applyClaims(uid, role, functionLevel);
  await writeUserDoc(uid, { role, functionLevel });
  return { uid, role, functionLevel };
});

// Disable a user account (cannot sign in) and clear privileged claims.
exports.disableUser = onCall(async (request) => {
  requireMfaAdmin(request);
  const { uid } = request.data || {};
  if (!uid) {
    throw new HttpsError('invalid-argument', 'A uid is required.');
  }
  if (uid === request.auth.uid) {
    throw new HttpsError('failed-precondition', 'You cannot disable your own account.');
  }
  await getAuth().updateUser(uid, { disabled: true });
  await getAuth().setCustomUserClaims(uid, {});
  await writeUserDoc(uid, { status: 'disabled', role: null, functionLevel: null });
  return { uid, status: 'disabled' };
});

// Re-enable a previously disabled account.
exports.enableUser = onCall(async (request) => {
  requireMfaAdmin(request);
  const { uid, role = 'volunteer', functionLevel = 'operations' } = request.data || {};
  if (!uid) {
    throw new HttpsError('invalid-argument', 'A uid is required.');
  }
  assertRoleCombo(role, functionLevel);
  await getAuth().updateUser(uid, { disabled: false });
  await applyClaims(uid, role, functionLevel);
  await writeUserDoc(uid, { status: 'active', role, functionLevel });
  return { uid, status: 'active' };
});

// Unenroll all TOTP factors so the user must set up MFA again at next sign-in.
exports.resetUserMfa = onCall(async (request) => {
  requireMfaAdmin(request);
  const { uid } = request.data || {};
  if (!uid) {
    throw new HttpsError('invalid-argument', 'A uid is required.');
  }
  const auth = getAuth();
  const userRecord = await auth.getUser(uid);
  const factors = userRecord.multiFactor?.enrolledFactors || [];
  for (const factor of factors) {
    await auth.updateUser(uid, {
      multiFactor: { enrolledFactors: [{ uid: factor.uid, delete: true }] }
    });
  }
  await writeUserDoc(uid, { mfaEnrolled: false });
  return { uid, removed: factors.length };
});

// List user records for the admin UI. Reads from Auth, merged with users docs.
exports.listUsers = onCall(async (request) => {
  requireMfaAdmin(request);
  const auth = getAuth();
  const users = [];
  let pageToken;
  do {
    const result = await auth.listUsers(1000, pageToken);
    for (const record of result.users) {
      const doc = await db.collection('users').doc(record.uid).get();
      const profile = doc.exists ? doc.data() : {};
      users.push({
        uid: record.uid,
        email: record.email || '',
        displayName: record.displayName || '',
        disabled: record.disabled,
        mfaEnrolled: (record.multiFactor?.enrolledFactors || []).length > 0,
        role: profile.role ?? record.customClaims?.role ?? null,
        functionLevel: profile.functionLevel ?? record.customClaims?.functionLevel ?? null,
        status: profile.status ?? (record.disabled ? 'disabled' : 'active')
      });
    }
    pageToken = result.pageToken;
  } while (pageToken);
  return { users };
});

// Callable Cloud Functions for CWB account administration.
// All privileged operations require a signed-in caller with the admin custom
// claim AND a TOTP-verified session (second factor present in the ID token).
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { requireAuthenticatedUser, requireMfaAdmin, requireMfaOperations } = require('./authGuards');
const { logSecurityEvent, pseudonymousId } = require('./securityLog');

if (!getApps().length) {
  initializeApp();
}
const db = getFirestore();

const ROLES = ['admin', 'manager', 'staff', 'volunteer'];
const FUNCTION_LEVELS = ['operations', 'administration'];

// Verified sign-ins from this domain are automatically provisioned with the
// default role below instead of waiting for a manual invitation. Admins can
// elevate (or suspend) the account afterwards from Account Administration.
const AUTO_PROVISION_DOMAIN = 'cwb.org';
const AUTO_PROVISION_ROLE = 'staff';
const AUTO_PROVISION_FUNCTION_LEVEL = 'operations';
const CALLABLE_OPTIONS = {
  enforceAppCheck: true,
  serviceAccount: 'cwb-user-admin@cwb-boat-operations-c50dd.iam.gserviceaccount.com'
};

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

async function applyClaims(uid, role, functionLevel, revokeSessions = true) {
  const claims = { role, functionLevel };
  if (role === 'admin') {
    claims.admin = true;
  }
  const auth = getAuth();
  await auth.setCustomUserClaims(uid, claims);
  if (revokeSessions) await auth.revokeRefreshTokens(uid);
}

// Self-service default role for verified accounts on the CWB staff domain.
// Called by the auth guard when a signed-in user has no role yet. The email
// and its verification state come from the ID token, never from client input.
exports.claimDefaultRole = onCall(CALLABLE_OPTIONS, async (request) => {
  requireAuthenticatedUser(request);
  const token = request.auth.token || {};
  if (token.role || token.admin === true) {
    return { granted: false, role: token.role || 'admin' };
  }

  const auth = getAuth();
  const userRecord = await auth.getUser(request.auth.uid);
  const email = String(userRecord.email || '').toLowerCase();
  if (userRecord.emailVerified !== true || !email.endsWith(`@${AUTO_PROVISION_DOMAIN}`)) {
    throw new HttpsError(
      'permission-denied',
      `Automatic access is limited to verified @${AUTO_PROVISION_DOMAIN} accounts. Ask a CWB administrator for an invitation.`
    );
  }

  // The token can be stale; re-check the live user record so we never
  // downgrade a role an admin granted moments ago.
  const existing = userRecord.customClaims || {};
  if (existing.role || existing.admin === true) {
    return { granted: false, role: existing.role || 'admin' };
  }
  const profileDoc = await db.collection('users').doc(request.auth.uid).get();
  if (profileDoc.exists && profileDoc.data().status === 'suspended') {
    throw new HttpsError('permission-denied', 'This account has been suspended by an administrator.');
  }

  await applyClaims(request.auth.uid, AUTO_PROVISION_ROLE, AUTO_PROVISION_FUNCTION_LEVEL, false);
  await writeUserDoc(request.auth.uid, {
    email,
    displayName: userRecord.displayName || '',
    role: AUTO_PROVISION_ROLE,
    functionLevel: AUTO_PROVISION_FUNCTION_LEVEL,
    status: 'active',
    createdBy: 'domain-auto-provision',
    createdAt: FieldValue.serverTimestamp()
  });
  return { granted: true, role: AUTO_PROVISION_ROLE, functionLevel: AUTO_PROVISION_FUNCTION_LEVEL };
});

// Invite (or create) a user by email and assign role + function level.
exports.inviteUser = onCall(CALLABLE_OPTIONS, async (request) => {
  await requireMfaAdmin(request);
  const { email, displayName = '', address = '', role = 'staff', functionLevel = 'operations' } = request.data || {};
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
      userRecord = await auth.createUser({
        email,
        displayName: displayName || undefined,
        emailVerified: false
      });
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
    address: address || '',
    role,
    functionLevel,
    status: 'active',
    createdBy: request.auth.uid,
    createdAt: FieldValue.serverTimestamp()
  });
  return { uid: userRecord.uid, email, displayName, address, role, functionLevel };
});

// Update an existing user's profile information (displayName, address, role, functionLevel).
exports.updateUserProfile = onCall(CALLABLE_OPTIONS, async (request) => {
  await requireMfaAdmin(request);
  const { uid, displayName = '', address = '', role, functionLevel } = request.data || {};
  if (!uid || typeof uid !== 'string') {
    throw new HttpsError('invalid-argument', 'A user ID is required.');
  }
  assertRoleCombo(role, functionLevel);
  if (uid === request.auth.uid && role !== 'admin') {
    throw new HttpsError('failed-precondition', 'You cannot remove your own administrator role.');
  }

  const auth = getAuth();
  await auth.updateUser(uid, {
    displayName: displayName || undefined
  });

  await applyClaims(uid, role, functionLevel);
  await writeUserDoc(uid, {
    displayName: displayName || '',
    address: address || '',
    role,
    functionLevel
  });

  return { uid, displayName, address, role, functionLevel };
});

// Change role/functionLevel for an existing user.
exports.setUserRole = onCall(CALLABLE_OPTIONS, async (request) => {
  await requireMfaAdmin(request);
  const { uid, role, functionLevel } = request.data || {};
  if (!uid) {
    throw new HttpsError('invalid-argument', 'A uid is required.');
  }
  assertRoleCombo(role, functionLevel);
  if (uid === request.auth.uid && role !== 'admin') {
    throw new HttpsError('failed-precondition', 'You cannot remove your own administrator role.');
  }
  await applyClaims(uid, role, functionLevel);
  await writeUserDoc(uid, { role, functionLevel });
  return { uid, role, functionLevel };
});

// Disable / Suspend a user account (cannot sign in) and clear privileged claims.
exports.disableUser = onCall(CALLABLE_OPTIONS, async (request) => {
  await requireMfaAdmin(request);
  const { uid } = request.data || {};
  if (!uid) {
    throw new HttpsError('invalid-argument', 'A uid is required.');
  }
  if (uid === request.auth.uid) {
    throw new HttpsError('failed-precondition', 'You cannot suspend your own account.');
  }
  await getAuth().updateUser(uid, { disabled: true });
  await getAuth().setCustomUserClaims(uid, {});
  await getAuth().revokeRefreshTokens(uid);
  logSecurityEvent('user_suspended', { actor: pseudonymousId(request.auth.uid), target: pseudonymousId(uid) });
  await writeUserDoc(uid, { status: 'suspended', role: null, functionLevel: null });
  return { uid, status: 'suspended' };
});

// Re-enable a previously suspended account.
exports.enableUser = onCall(CALLABLE_OPTIONS, async (request) => {
  await requireMfaAdmin(request);
  const { uid, role = 'volunteer', functionLevel = 'operations' } = request.data || {};
  if (!uid) {
    throw new HttpsError('invalid-argument', 'A uid is required.');
  }
  assertRoleCombo(role, functionLevel);
  await getAuth().updateUser(uid, { disabled: false });
  await applyClaims(uid, role, functionLevel);
  logSecurityEvent('user_enabled', { actor: pseudonymousId(request.auth.uid), target: pseudonymousId(uid) });
  await writeUserDoc(uid, { status: 'active', role, functionLevel });
  return { uid, status: 'active' };
});

// Delete a user completely from Authentication and Firestore.
exports.deleteUser = onCall(CALLABLE_OPTIONS, async (request) => {
  await requireMfaAdmin(request);
  const { uid } = request.data || {};
  if (!uid) {
    throw new HttpsError('invalid-argument', 'A uid is required.');
  }
  if (uid === request.auth.uid) {
    throw new HttpsError('failed-precondition', 'You cannot delete your own account.');
  }
  const auth = getAuth();
  try {
    await auth.deleteUser(uid);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') {
      throw error;
    }
  }
  await db.collection('users').doc(uid).delete();
  return { uid, deleted: true };
});

// Unenroll all TOTP factors so the user must set up MFA again at next sign-in.
exports.resetUserMfa = onCall(CALLABLE_OPTIONS, async (request) => {
  await requireMfaAdmin(request);
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
  await auth.revokeRefreshTokens(uid);
  logSecurityEvent('user_mfa_reset', { actor: pseudonymousId(request.auth.uid), target: pseudonymousId(uid) });
  await writeUserDoc(uid, { mfaEnrolled: false });
  return { uid, removed: factors.length };
});

async function listAllAuthRecords(auth) {
  const records = [];
  let pageToken;
  do {
    const result = await auth.listUsers(1000, pageToken);
    records.push(...result.users);
    pageToken = result.pageToken;
  } while (pageToken);
  return records;
}

// List user records for the admin UI. Reads from Auth, merged with users docs.
// The Auth pages and the whole users collection are fetched concurrently and
// joined in memory; fetching one profile doc per user serially made this call
// scale with the size of the roster.
exports.listUsers = onCall(CALLABLE_OPTIONS, async (request) => {
  await requireMfaAdmin(request);
  const auth = getAuth();

  const [records, profileSnapshot] = await Promise.all([
    listAllAuthRecords(auth),
    db.collection('users').get()
  ]);

  const profiles = new Map();
  profileSnapshot.forEach((doc) => profiles.set(doc.id, doc.data()));

  const users = records.map((record) => {
    const profile = profiles.get(record.uid) || {};
    const suspended = record.disabled || profile.status === 'suspended';
    return {
      uid: record.uid,
      email: record.email || '',
      displayName: profile.displayName || record.displayName || '',
      address: profile.address || '',
      disabled: suspended,
      mfaEnrolled: (record.multiFactor?.enrolledFactors || []).length > 0,
      role: profile.role ?? record.customClaims?.role ?? null,
      functionLevel: profile.functionLevel ?? record.customClaims?.functionLevel ?? null,
      status: suspended ? 'suspended' : (profile.status || 'active'),
      loginCount: profile.loginCount || 0,
      lastLogin: profile.lastLogin || record.metadata?.lastSignInTime || null,
      createdAt: profile.createdAt || record.metadata?.creationTime || null
    };
  });

  return { users };
});

// End an active rental server-side so telemetry cannot append a breadcrumb
// between trail deletion and disabling tracking.
exports.checkInBoat = onCall(CALLABLE_OPTIONS, async (request) => {
  await requireMfaOperations(request);
  const { boatId } = request.data || {};
  if (!/^[0-9a-f]{16}$/i.test(boatId || '')) {
    throw new HttpsError('invalid-argument', 'A 16-character hexadecimal Device ID is required.');
  }

  const boatRef = db.collection('boats').doc(boatId);
  const rentalHistoryRef = db.collection('rental_history').doc();
  const rentalEnded = await db.runTransaction(async (transaction) => {
    const boatSnapshot = await transaction.get(boatRef);
    if (!boatSnapshot.exists) {
      throw new HttpsError('not-found', 'Boat not found.');
    }
    const boat = boatSnapshot.data();
    if (boat.tracking_enabled !== true) {
      return false;
    }

    const checkedInAt = new Date();
    const checkedOutAt = boat.time_out?.toDate?.() || null;
    transaction.create(rentalHistoryRef, {
      device_id: boatId,
      vessel_name: boat.vessel_name || '',
      boat_type: boat.boat_type || '',
      renter_type: boat.renter_type || '',
      checked_out_at: boat.time_out || null,
      checked_in_at: FieldValue.serverTimestamp(),
      duration_minutes: checkedOutAt
        ? Math.max(0, Math.round((checkedInAt - checkedOutAt) / 60000))
        : 0,
      passenger_count: Number.isInteger(boat.passenger_count) ? boat.passenger_count : 0
    });
    transaction.update(boatRef, {
      availability_status: 'available',
      tracking_enabled: false,
      booked: false,
      booked_by: FieldValue.delete(),
      renter_type: FieldValue.delete(),
      passenger_count: FieldValue.delete(),
      time_out: FieldValue.delete(),
      actual_time_back: FieldValue.delete(),
      'last_ping.latitude': FieldValue.delete(),
      'last_ping.longitude': FieldValue.delete(),
      rental_updated_at: FieldValue.serverTimestamp()
    });
    return true;
  });

  // Always retry trail deletion so a prior cleanup failure cannot strand GPS history.
  await db.recursiveDelete(boatRef.collection('history'));
  return { boatId, checkedIn: rentalEnded };
});

// Callable Cloud Functions for CWB account administration.
// All privileged operations require a signed-in caller with the admin custom
// claim AND a TOTP-verified session (second factor present in the ID token).
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('node:crypto');
const nodemailer = require('nodemailer');
const { requireAuthenticatedUser, requireMfaAdmin, requireMfaOperations } = require('./authGuards');
const { logSecurityEvent, pseudonymousId } = require('./securityLog');

if (!getApps().length) {
  initializeApp();
}
const db = getFirestore();

const ROLES = ['admin', 'manager', 'staff', 'volunteer'];
const FUNCTION_LEVELS = ['operations', 'administration'];

const GMAIL_SENDER_EMAIL = defineSecret('GMAIL_SENDER_EMAIL');
const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');
const LIFECYCLE_NOTIFICATION_KEY = defineSecret('LIFECYCLE_NOTIFICATION_KEY');
const CALLABLE_OPTIONS = {
  enforceAppCheck: true,
  serviceAccount: 'cwb-user-admin@cwb-boat-operations-c50dd.iam.gserviceaccount.com'
};
const INVITATION_CALLABLE_OPTIONS = {
  ...CALLABLE_OPTIONS,
  enforceAppCheck: false,
  maxInstances: 5,
  concurrency: 20
};
const LIFECYCLE_CALLABLE_OPTIONS = {
  ...CALLABLE_OPTIONS,
  secrets: [GMAIL_SENDER_EMAIL, GMAIL_APP_PASSWORD, LIFECYCLE_NOTIFICATION_KEY]
};
const SESSION_EXIT_REASONS = new Set(['session-revoked', 'session-unverifiable', 'role-required', 'function-required', 'admin-required']);
const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

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

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validateLifecycleRequest(data, userRecord, requireReason = false) {
  const confirmationEmail = typeof data?.confirmationEmail === 'string' ? data.confirmationEmail.trim() : '';
  const displayedEmail = typeof userRecord?.email === 'string' ? userRecord.email.trim() : '';
  const accountEmail = normalizeEmail(userRecord?.email);
  if (!confirmationEmail || !accountEmail || confirmationEmail !== displayedEmail) {
    throw new HttpsError('failed-precondition', 'Type the account email address exactly to confirm this action.');
  }
  const reason = typeof data?.reason === 'string' ? data.reason.trim() : '';
  if (requireReason && (reason.length < 10 || reason.length > 1000)) {
    throw new HttpsError('invalid-argument', 'A suspension explanation between 10 and 1000 characters is required.');
  }
  return { email: accountEmail, reason };
}

function lifecycleEncryptionKey() {
  const key = Buffer.from(LIFECYCLE_NOTIFICATION_KEY.value(), 'base64');
  if (key.length !== 32) throw new Error('LIFECYCLE_NOTIFICATION_KEY must be a base64-encoded 32-byte key.');
  return key;
}

function encryptLifecycleMessage(message) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', lifecycleEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decryptLifecycleMessage(encrypted) {
  const decipher = createDecipheriv('aes-256-gcm', lifecycleEncryptionKey(), Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8'));
}

function lifecycleJobExpired(job, now = Date.now()) {
  return (job.expiresAt?.toMillis?.() || 0) <= now;
}

function lifecycleNotificationExpired(job, now = Date.now()) {
  return job.operationCompleted === true && lifecycleJobExpired(job, now);
}

function hasTotpFactor(userRecord) {
  return (userRecord?.multiFactor?.enrolledFactors || []).some(factor => factor.factorId === 'totp');
}

async function waitForTotpEnrollment(uid, getUser = value => getAuth().getUser(value), pause = delay => new Promise(resolve => setTimeout(resolve, delay))) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const userRecord = await getUser(uid);
    if (hasTotpFactor(userRecord)) return userRecord;
    if (attempt < 5) await pause(500);
  }
  throw new HttpsError('failed-precondition', 'Complete authenticator enrollment before activating this invitation.');
}

function reportsActiveMfa(userRecord, profile, invitationDocument) {
  return userRecord?.disabled !== true && profile?.status === 'active' && !invitationDocument && hasTotpFactor(userRecord);
}

async function sendLifecycleEmail({ to, subject, text }, transport, lifecycleJobId = '') {
  const from = GMAIL_SENDER_EMAIL.value();
  const appPassword = GMAIL_APP_PASSWORD.value();
  if (!from || !appPassword) throw new Error('Account notification email is not configured.');
  const mailTransport = transport || nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: from, pass: appPassword }
  });
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mailTransport.sendMail({
        from,
        to,
        subject,
        text,
        headers: lifecycleJobId ? { 'X-CWB-Lifecycle-Job': lifecycleJobId } : undefined
      });
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Email delivery failed.');
}

async function queueLifecycleJob(payload, operationCompleted = false) {
  const reference = db.collection('lifecycle_notification_outbox').doc();
  await reference.create({
    ...encryptLifecycleMessage(payload),
    attempts: 0,
    operationCompleted,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
    nextAttemptAt: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000)
  });
  return reference;
}

async function performLifecycleOperation(payload) {
  const auth = getAuth();
  let userExists = true;
  try {
    await auth.getUser(payload.uid);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
    userExists = false;
  }

  if (payload.action === 'suspend') {
    if (!userExists) throw new Error('The account no longer exists.');
    await db.collection('users').doc(payload.uid).set({
      status: 'suspended', role: null, functionLevel: null, updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    await auth.updateUser(payload.uid, { disabled: true, displayName: null, photoURL: null });
    await auth.setCustomUserClaims(payload.uid, {});
    await auth.revokeRefreshTokens(payload.uid);
    await db.recursiveDelete(db.collection('users').doc(payload.uid));
    await db.collection('users').doc(payload.uid).create({
      status: 'suspended',
      suspendedAt: FieldValue.serverTimestamp()
    });
    await deleteLinkedInvitations(payload.uid, payload.email);
  } else if (payload.action === 'delete') {
    await db.collection('users').doc(payload.uid).set({
      status: 'deleting', role: null, functionLevel: null, updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    if (userExists) {
      await auth.updateUser(payload.uid, { disabled: true });
      await auth.setCustomUserClaims(payload.uid, {});
      await auth.revokeRefreshTokens(payload.uid);
    }
    await Promise.all([
      db.recursiveDelete(db.collection('users').doc(payload.uid)),
      deleteLinkedInvitations(payload.uid, payload.email)
    ]);
    if (userExists) await auth.deleteUser(payload.uid);
  } else {
    throw new Error('Unsupported lifecycle action.');
  }
}

async function processQueuedLifecycleJob(reference) {
  const claimed = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return null;
    const processingUntil = snapshot.get('processingUntil')?.toMillis?.() || 0;
    if (processingUntil > Date.now()) return { busy: true };
    transaction.update(reference, {
      processingUntil: Timestamp.fromMillis(Date.now() + 6 * 60 * 1000)
    });
    return { data: snapshot.data() };
  });
  if (!claimed) return { operationCompleted: true, notificationSent: true };
  if (claimed.busy) return { operationCompleted: false, notificationSent: false, busy: true };
  const job = claimed.data;
  let operationCompleted = job.operationCompleted === true;
  if (lifecycleNotificationExpired(job)) {
    logSecurityEvent('account_notification_expired', {}, 'ERROR');
    await reference.delete();
    return { operationCompleted, notificationSent: false, expired: true };
  }
  try {
    const payload = decryptLifecycleMessage(job);
    if (!operationCompleted) {
      await performLifecycleOperation(payload);
      operationCompleted = true;
      await reference.update({ operationCompleted: true });
      logSecurityEvent(`user_${payload.action === 'delete' ? 'deleted' : 'suspended'}`, {
        actor: pseudonymousId(payload.actorUid),
        target: pseudonymousId(payload.uid)
      });
    }
    if (lifecycleJobExpired(job)) {
      logSecurityEvent('account_notification_expired', {}, 'ERROR');
      await reference.delete();
      return { operationCompleted, notificationSent: false, expired: true };
    }
    await sendLifecycleEmail(payload.message, undefined, `cwb-lifecycle-${reference.id}`);
    await reference.delete();
    return { operationCompleted: true, notificationSent: true };
  } catch {
    const attempts = Number(job.attempts || 0) + 1;
    if (operationCompleted && lifecycleJobExpired(job)) {
      logSecurityEvent('account_notification_expired', {}, 'ERROR');
      await reference.delete();
    } else {
      if (attempts >= 3) logSecurityEvent('account_notification_retrying', { attempts }, 'ERROR');
      await reference.update({
        attempts,
        processingUntil: FieldValue.delete(),
        nextAttemptAt: Timestamp.fromMillis(Date.now() + 15 * 60 * 1000)
      });
    }
    return { operationCompleted, notificationSent: false };
  }
}

async function completeImmediateDeletion(payload, performOperation = performLifecycleOperation, queueNotification = queueLifecycleJob) {
  await performOperation(payload);
  logSecurityEvent('user_deleted', {
    actor: pseudonymousId(payload.actorUid),
    target: pseudonymousId(payload.uid)
  });
  try {
    await queueNotification(payload, true);
    return { operationCompleted: true, deleted: true, notificationQueued: true, notificationSent: false };
  } catch {
    logSecurityEvent('account_notification_failed', { target: pseudonymousId(payload.uid), action: 'delete' }, 'ERROR');
    return { operationCompleted: true, deleted: true, notificationQueued: false, notificationSent: false };
  }
}

async function deleteLinkedInvitations(uid, email) {
  const normalizedEmail = normalizeEmail(email);
  const queries = [
    db.collection('user_invitations').where('email', '==', normalizedEmail),
    db.collection('user_invitations').where('reservedUid', '==', uid),
    db.collection('user_invitations').where('createdBy', '==', uid)
  ];
  const snapshots = await Promise.all(queries.map(query => query.get()));
  const references = new Map();
  snapshots.forEach(snapshot => snapshot.docs.forEach(document => references.set(document.ref.path, document.ref)));
  const invitationIds = new Set([...references.values()].map(reference => reference.id));
  const reservationRef = normalizedEmail
    ? db.collection('invitation_email_reservations').doc(invitationReservationId(normalizedEmail))
    : null;
  await db.runTransaction(async transaction => {
    const reservation = reservationRef ? await transaction.get(reservationRef) : null;
    references.forEach(reference => transaction.delete(reference));
    if (reservation?.exists && invitationIds.has(String(reservation.get('invitationId') || ''))) {
      transaction.delete(reservationRef);
    }
  });
  return references.size;
}

function hashInvitationValue(value) {
  return createHash('sha256').update(value).digest('hex');
}

function invitationReservationId(email) {
  return hashInvitationValue(`email:${normalizeEmail(email)}`);
}

function invitationToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInvitationValue(token) };
}

function assertUsableInvitation(invitation, now = Date.now()) {
  if (!invitation || !['pending', 'reserved'].includes(invitation.status)) {
    throw new HttpsError('failed-precondition', 'This invitation is invalid or has already been used.');
  }
  const expiresAt = invitation.expiresAt?.toMillis?.() ?? Number(invitation.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new HttpsError('failed-precondition', 'This invitation is invalid or has already been used.');
  }
}

function invitationIsActive(invitation, now = Date.now()) {
  if (!invitation || !['pending', 'reserved'].includes(invitation.status)) return false;
  const expiresAt = invitation.expiresAt?.toMillis?.() ?? Number(invitation.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function invitationBlocksEmail(invitation, now = Date.now()) {
  if (!invitation || !['pending', 'reserved', 'cancelling'].includes(invitation.status)) return false;
  const expiresAt = invitation.expiresAt?.toMillis?.() ?? Number(invitation.expiresAt);
  return invitation.status === 'cancelling' || (Number.isFinite(expiresAt) && expiresAt > now);
}

function invitationMatchesUser(invitation, userRecord) {
  return invitation?.reservedUid === userRecord?.uid
    || (normalizeEmail(invitation?.email) !== ''
      && normalizeEmail(invitation.email) === normalizeEmail(userRecord?.email));
}

function assertInvitationIdentity(invitation, userRecord) {
  if (userRecord.emailVerified !== true || normalizeEmail(userRecord.email) !== invitation.email) {
    throw new HttpsError('permission-denied', 'This invitation does not match the verified signed-in account.');
  }
  if (invitation.status === 'reserved' && invitation.reservedUid !== userRecord.uid) {
    throw new HttpsError('failed-precondition', 'This invitation is invalid or has already been used.');
  }
}

function buildIdentityUpdate(userRecord, email, displayName) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new HttpsError('invalid-argument', 'An email address is required.');
  }
  const emailChanged = normalizeEmail(userRecord.email) !== normalizedEmail;
  return {
    email: normalizedEmail,
    emailChanged,
    authUpdate: {
      email: normalizedEmail,
      displayName: displayName || undefined,
      ...(emailChanged ? { emailVerified: false } : {})
    }
  };
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

exports.reportSessionExit = onCall(CALLABLE_OPTIONS, async (request) => {
  requireAuthenticatedUser(request);
  const reason = String(request.data?.reason || 'session-revoked');
  if (!SESSION_EXIT_REASONS.has(reason)) {
    throw new HttpsError('invalid-argument', 'Unknown session exit reason.');
  }
  logSecurityEvent('browser_session_forced_exit', {
    actor: pseudonymousId(request.auth.uid),
    reason
  }, 'WARNING');
  return { recorded: true };
});

exports.recordUserLogin = onCall(CALLABLE_OPTIONS, async (request) => {
  requireAuthenticatedUser(request);
  const [userRecord, profileSnapshot] = await Promise.all([
    getAuth().getUser(request.auth.uid),
    db.collection('users').doc(request.auth.uid).get()
  ]);
  if (!profileSnapshot.exists || profileSnapshot.get('status') !== 'active'
      || normalizeEmail(profileSnapshot.get('email')) !== normalizeEmail(userRecord.email)) {
    throw new HttpsError('permission-denied', 'An active account is required.');
  }
  await profileSnapshot.ref.set({ lastLogin: FieldValue.serverTimestamp(), loginCount: FieldValue.increment(1) }, { merge: true });
  return { recorded: true };
});

exports.recordMfaEnrollment = onCall(CALLABLE_OPTIONS, async (request) => {
  requireAuthenticatedUser(request);
  const [userRecord, profileSnapshot] = await Promise.all([
    getAuth().getUser(request.auth.uid),
    db.collection('users').doc(request.auth.uid).get()
  ]);
  if (!(userRecord.multiFactor?.enrolledFactors || []).some(factor => factor.factorId === 'totp')) {
    throw new HttpsError('failed-precondition', 'No enrolled authenticator was found.');
  }
  if (!profileSnapshot.exists || !['pending_mfa', 'active'].includes(profileSnapshot.get('status'))
      || normalizeEmail(profileSnapshot.get('email')) !== normalizeEmail(userRecord.email)) {
    throw new HttpsError('permission-denied', 'A verified invitation or active account is required.');
  }
  await profileSnapshot.ref.set({ mfaEnrolled: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { recorded: true };
});

// Create a pending invitation. No Auth user, profile, or role claim is created
// until the recipient proves mailbox control and completes MFA enrollment.
exports.inviteUser = onCall(CALLABLE_OPTIONS, async (request) => {
  await requireMfaAdmin(request);
  const { email, displayName = '', address = '', role = 'staff', functionLevel = 'operations' } = request.data || {};
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new HttpsError('invalid-argument', 'An email address is required.');
  }
  assertRoleCombo(role, functionLevel);

  try {
    await getAuth().getUserByEmail(normalizedEmail);
    throw new HttpsError('already-exists', 'This email already has a CWB account. Edit or reactivate that account instead.');
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
  }

  const { token, tokenHash } = invitationToken();
  const invitationRef = db.collection('user_invitations').doc(tokenHash);
  const reservationRef = db.collection('invitation_email_reservations').doc(invitationReservationId(normalizedEmail));
  const legacyInvitations = await db.collection('user_invitations').where('email', '==', normalizedEmail).get();
  if (legacyInvitations.docs.some(document => invitationBlocksEmail(document.data()))) {
    throw new HttpsError('already-exists', 'An invitation for this email is already pending.');
  }
  await db.runTransaction(async transaction => {
    const reservation = await transaction.get(reservationRef);
    if (reservation.exists) {
      const existingInvitation = await transaction.get(
        db.collection('user_invitations').doc(String(reservation.get('invitationId') || 'invalid'))
      );
      if (existingInvitation.exists && invitationBlocksEmail(existingInvitation.data())) {
        throw new HttpsError('already-exists', 'An invitation for this email is already pending or being cancelled.');
      }
    }
    transaction.create(invitationRef, {
      email: normalizedEmail,
      displayName: displayName || '',
      address: address || '',
      role,
      functionLevel,
      status: 'pending',
      createdBy: request.auth.uid,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + INVITATION_TTL_MS)
    });
    transaction.set(reservationRef, {
      invitationId: invitationRef.id,
      expiresAt: Timestamp.fromMillis(Date.now() + INVITATION_TTL_MS)
    });
  });
  logSecurityEvent('user_invitation_created', { actor: pseudonymousId(request.auth.uid) });
  return { invitationId: invitationRef.id, token, email: normalizedEmail, expiresInHours: 24 };
});

exports.cancelUserInvitation = onCall(CALLABLE_OPTIONS, async (request) => {
  await requireMfaAdmin(request);
  const invitationId = String(request.data?.invitationId || '');
  if (!/^[0-9a-f]{64}$/.test(invitationId)) throw new HttpsError('invalid-argument', 'Invalid invitation.');
  const invitationRef = db.collection('user_invitations').doc(invitationId);
  const cancellation = await db.runTransaction(async transaction => {
    const invitationSnapshot = await transaction.get(invitationRef);
    if (!invitationSnapshot.exists) {
      throw new HttpsError('failed-precondition', 'This invitation is no longer pending. Refresh the account list.');
    }
    const invitation = invitationSnapshot.data();
    transaction.update(invitationRef, { status: 'cancelling', updatedAt: FieldValue.serverTimestamp() });
    return { reservedUid: invitation.reservedUid || '', email: normalizeEmail(invitation.email) };
  });
  if (cancellation.reservedUid) {
    try {
      await getAuth().updateUser(cancellation.reservedUid, { disabled: true });
      await getAuth().setCustomUserClaims(cancellation.reservedUid, {});
      await getAuth().revokeRefreshTokens(cancellation.reservedUid);
      await getAuth().deleteUser(cancellation.reservedUid);
    } catch (error) {
      if (error.code !== 'auth/user-not-found') throw error;
    }
  }
  await db.runTransaction(async transaction => {
    const reservationRef = cancellation.email
      ? db.collection('invitation_email_reservations').doc(invitationReservationId(cancellation.email))
      : null;
    const [invitationSnapshot, profileSnapshot, reservationSnapshot] = await Promise.all([
      transaction.get(invitationRef),
      cancellation.reservedUid
        ? transaction.get(db.collection('users').doc(cancellation.reservedUid))
        : Promise.resolve(null),
      reservationRef ? transaction.get(reservationRef) : Promise.resolve(null)
    ]);
    if (profileSnapshot?.exists && profileSnapshot.get('status') === 'pending_mfa'
        && profileSnapshot.get('invitationId') === invitationId) transaction.delete(profileSnapshot.ref);
    if (invitationSnapshot.exists && invitationSnapshot.get('status') === 'cancelling') transaction.delete(invitationRef);
    if (reservationSnapshot?.exists && reservationSnapshot.get('invitationId') === invitationId) {
      transaction.delete(reservationRef);
    }
  });
  return { cancelled: true };
});

async function acceptUserInvitationRequest(request, dependencies = {}) {
  requireAuthenticatedUser(request);
  const token = String(request.data?.token || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpsError('failed-precondition', 'This invitation is invalid or has already been used.');
  const firestore = dependencies.db || db;
  const auth = dependencies.auth || getAuth();
  const invitationRef = firestore.collection('user_invitations').doc(hashInvitationValue(token));
  const userRecord = await auth.getUser(request.auth.uid);
  const userRef = firestore.collection('users').doc(request.auth.uid);

  const invitation = await firestore.runTransaction(async transaction => {
    const [snapshot, userSnapshot] = await Promise.all([
      transaction.get(invitationRef), transaction.get(userRef)
    ]);
    const data = snapshot.exists ? snapshot.data() : null;
    assertUsableInvitation(data);
    assertInvitationIdentity(data, userRecord);
    if (userSnapshot.exists && userSnapshot.get('status') === 'active') {
      throw new HttpsError('already-exists', 'This account is already active.');
    }
    transaction.update(invitationRef, {
      status: 'reserved', reservedUid: request.auth.uid,
      reservedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    transaction.set(userRef, {
      email: data.email, displayName: data.displayName || userRecord.displayName || '',
      address: data.address || '', status: 'pending_mfa', invitationId: snapshot.id,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return data;
  });
  return { accepted: true, email: invitation.email };
}

async function completeUserInvitationRequest(request, dependencies = {}) {
  requireAuthenticatedUser(request);
  const token = String(request.data?.token || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpsError('failed-precondition', 'This invitation is invalid or has already been used.');
  const firestore = dependencies.db || db;
  const auth = dependencies.auth || getAuth();
  const waitForTotp = dependencies.waitForTotpEnrollment || waitForTotpEnrollment;
  const applyUserClaims = dependencies.applyClaims || applyClaims;
  const invitationRef = firestore.collection('user_invitations').doc(hashInvitationValue(token));
  const userRecord = await waitForTotp(request.auth.uid);
  const snapshot = await invitationRef.get();
  const invitation = snapshot.exists ? snapshot.data() : null;
  assertUsableInvitation(invitation);
  assertInvitationIdentity(invitation, userRecord);
  if (invitation.status !== 'reserved' || invitation.reservedUid !== request.auth.uid) {
    throw new HttpsError('failed-precondition', 'This invitation is invalid or has already been used.');
  }

  await applyUserClaims(request.auth.uid, invitation.role, invitation.functionLevel, false);
  try {
    await firestore.runTransaction(async transaction => {
      const current = await transaction.get(invitationRef);
      const data = current.exists ? current.data() : null;
      assertUsableInvitation(data);
      assertInvitationIdentity(data, userRecord);
      if (data.status !== 'reserved') throw new HttpsError('failed-precondition', 'This invitation is invalid or has already been used.');
      transaction.set(firestore.collection('users').doc(request.auth.uid), {
        email: data.email, displayName: data.displayName || userRecord.displayName || '',
        address: data.address || '', role: data.role, functionLevel: data.functionLevel,
        status: 'active', mfaEnrolled: true, invitationId: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.delete(invitationRef);
      transaction.delete(firestore.collection('invitation_email_reservations').doc(invitationReservationId(data.email)));
    });
  } catch (error) {
    await auth.setCustomUserClaims(request.auth.uid, {});
    throw error;
  }
  await auth.revokeRefreshTokens(request.auth.uid);
  logSecurityEvent('user_invitation_completed', { actor: pseudonymousId(request.auth.uid) });
  return { activated: true };
}

exports.acceptUserInvitation = onCall(INVITATION_CALLABLE_OPTIONS, async request => {
  requireAuthenticatedUser(request);
  return acceptUserInvitationRequest(request);
});
exports.completeUserInvitation = onCall(INVITATION_CALLABLE_OPTIONS, async request => {
  requireAuthenticatedUser(request);
  return completeUserInvitationRequest(request);
});

// Update an existing user's identity, profile, and access settings.
exports.updateUserProfile = onCall(CALLABLE_OPTIONS, async (request) => {
  await requireMfaAdmin(request);
  const { uid, email, displayName = '', address = '', role, functionLevel } = request.data || {};
  if (!uid || typeof uid !== 'string') {
    throw new HttpsError('invalid-argument', 'A user ID is required.');
  }
  assertRoleCombo(role, functionLevel);
  if (uid === request.auth.uid && role !== 'admin') {
    throw new HttpsError('failed-precondition', 'You cannot remove your own administrator role.');
  }

  const auth = getAuth();
  const userRecord = await auth.getUser(uid);
  const identityUpdate = buildIdentityUpdate(userRecord, email, displayName);
  await auth.updateUser(uid, identityUpdate.authUpdate);

  await writeUserDoc(uid, {
    email: identityUpdate.email,
    displayName: displayName || '',
    address: address || '',
    role,
    functionLevel
  });
  await applyClaims(uid, role, functionLevel);
  if (identityUpdate.emailChanged) {
    logSecurityEvent('user_email_changed', {
      actor: pseudonymousId(request.auth.uid),
      target: pseudonymousId(uid)
    });
  }

  return { uid, email: identityUpdate.email, displayName, address, role, functionLevel };
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
  await writeUserDoc(uid, { role, functionLevel });
  await applyClaims(uid, role, functionLevel);
  return { uid, role, functionLevel };
});

// Disable / Suspend a user account (cannot sign in) and clear privileged claims.
exports.disableUser = onCall(LIFECYCLE_CALLABLE_OPTIONS, async (request) => {
  await requireMfaAdmin(request);
  const { uid } = request.data || {};
  if (!uid) {
    throw new HttpsError('invalid-argument', 'A uid is required.');
  }
  if (uid === request.auth.uid) {
    throw new HttpsError('failed-precondition', 'You cannot suspend your own account.');
  }
  const auth = getAuth();
  const userRecord = await auth.getUser(uid);
  const { email, reason } = validateLifecycleRequest(request.data, userRecord, true);
  const job = await queueLifecycleJob({
    action: 'suspend',
    actorUid: request.auth.uid,
    uid,
    email,
    message: {
      to: email,
      subject: 'Your CWB account has been suspended',
      text: `Your access to CWB Operations has been suspended by an administrator.\n\nExplanation:\n${reason}\n\nIf you believe this was an error, contact The Center for Wooden Boats.`
    }
  });
  const result = await processQueuedLifecycleJob(job);
  if (!result.notificationSent) {
    logSecurityEvent('account_notification_failed', { target: pseudonymousId(uid), action: 'suspend' }, 'ERROR');
  }
  return { uid, status: result.operationCompleted ? 'suspended' : 'queued', ...result };
});

// Re-enable a previously suspended account.
exports.enableUser = onCall(CALLABLE_OPTIONS, async (request) => {
  await requireMfaAdmin(request);
  const { uid, role, functionLevel } = request.data || {};
  if (!uid || !role || !functionLevel) {
    throw new HttpsError('invalid-argument', 'A user ID, role, and function level are required.');
  }
  assertRoleCombo(role, functionLevel);
  const auth = getAuth();
  const userRecord = await auth.getUser(uid);
  await auth.updateUser(uid, { disabled: false });
  await applyClaims(uid, role, functionLevel);
  logSecurityEvent('user_enabled', { actor: pseudonymousId(request.auth.uid), target: pseudonymousId(uid) });
  await writeUserDoc(uid, {
    email: normalizeEmail(userRecord.email),
    status: 'active',
    role,
    functionLevel,
    mfaEnrolled: (userRecord.multiFactor?.enrolledFactors || []).some(factor => factor.factorId === 'totp')
  });
  return { uid, status: 'active' };
});

// Delete a user completely from Authentication and Firestore.
exports.deleteUser = onCall(LIFECYCLE_CALLABLE_OPTIONS, async (request) => {
  await requireMfaAdmin(request);
  const { uid } = request.data || {};
  if (!uid) {
    throw new HttpsError('invalid-argument', 'A uid is required.');
  }
  if (uid === request.auth.uid) {
    throw new HttpsError('failed-precondition', 'You cannot delete your own account.');
  }
  const auth = getAuth();
  const userRecord = await auth.getUser(uid);
  const { email } = validateLifecycleRequest(request.data, userRecord);
  const result = await completeImmediateDeletion({
    action: 'delete',
    actorUid: request.auth.uid,
    uid,
    email,
    message: {
      to: email,
      subject: 'Your CWB account has been permanently deleted',
      text: 'Your CWB Operations account and personal profile data have been permanently deleted from active CWB systems. Your access credentials and enrolled two-factor authentication have also been removed.'
    }
  });
  return { uid, ...result };
});

exports.retryLifecycleNotifications = onSchedule({
  schedule: 'every 15 minutes',
  timeZone: 'America/Los_Angeles',
  retryCount: 3,
  timeoutSeconds: 300,
  maxInstances: 1,
  serviceAccount: 'cwb-user-admin@cwb-boat-operations-c50dd.iam.gserviceaccount.com',
  secrets: [GMAIL_SENDER_EMAIL, GMAIL_APP_PASSWORD, LIFECYCLE_NOTIFICATION_KEY]
}, async () => {
  const outbox = db.collection('lifecycle_notification_outbox');
  const expiredSnapshot = await outbox
    .where('expiresAt', '<=', Timestamp.now())
    .limit(500)
    .get();
  await Promise.all(expiredSnapshot.docs.map(document => processQueuedLifecycleJob(document.ref)));
  const snapshot = await outbox
    .where('nextAttemptAt', '<=', Timestamp.now())
    .limit(100)
    .get();
  await Promise.all(snapshot.docs.map(document => processQueuedLifecycleJob(document.ref)));
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

  const [records, profileSnapshot, invitationSnapshot] = await Promise.all([
    listAllAuthRecords(auth),
    db.collection('users').get(),
    db.collection('user_invitations').where('status', 'in', ['pending', 'reserved', 'cancelling']).get()
  ]);

  const profiles = new Map();
  profileSnapshot.forEach((doc) => profiles.set(doc.id, doc.data()));
  const activeInvitations = invitationSnapshot.docs.filter(document => invitationBlocksEmail(document.data()));
  const listedEmails = new Set();

  const users = records.map((record) => {
    const profile = profiles.get(record.uid) || {};
    const suspended = record.disabled || profile.status === 'suspended';
    const invitationDocument = activeInvitations.find(document => invitationMatchesUser(document.data(), record));
    const email = normalizeEmail(record.email);
    if (email) listedEmails.add(email);
    return {
      uid: record.uid,
      invitationId: invitationDocument?.id,
      email: record.email || '',
      displayName: profile.displayName || record.displayName || '',
      address: profile.address || '',
      disabled: suspended,
      mfaEnrolled: reportsActiveMfa(record, profile, invitationDocument),
      role: profile.role ?? record.customClaims?.role ?? null,
      functionLevel: profile.functionLevel ?? record.customClaims?.functionLevel ?? null,
      status: suspended ? 'suspended'
        : profile.status === 'active' ? 'active'
          : invitationDocument ? 'invited'
            : (profile.status || 'active'),
      loginCount: profile.loginCount || 0,
      lastLogin: profile.lastLogin || record.metadata?.lastSignInTime || null,
      createdAt: profile.createdAt || record.metadata?.creationTime || null
    };
  });

  invitationSnapshot.forEach((document) => {
    const invitation = document.data();
    const email = normalizeEmail(invitation.email);
    if (!invitationBlocksEmail(invitation) || (email && listedEmails.has(email))) return;
    if (email) listedEmails.add(email);
    users.push({
      uid: `invitation:${document.id}`,
      invitationId: document.id,
      email: invitation.email || '',
      displayName: invitation.displayName || '',
      address: invitation.address || '',
      disabled: false,
      mfaEnrolled: false,
      role: invitation.role || null,
      functionLevel: invitation.functionLevel || null,
      status: 'invited',
      loginCount: 0,
      lastLogin: null,
      createdAt: invitation.createdAt || null,
      expiresAt: invitation.expiresAt || null
    });
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
  const eventActivityRef = db.collection('events').doc('_placeholder').collection('activity').doc();
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
    const eventId = typeof boat.event_id === 'string' && !boat.event_id.includes('/') ? boat.event_id : '';
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
      passenger_count: Number.isInteger(boat.passenger_count) ? boat.passenger_count : 0,
      use_type: boat.use_type || 'rental',
      event_id: eventId,
      event_name: eventId ? (boat.event_name || '') : ''
    });
    if (eventId) {
      const eventRef = db.collection('events').doc(eventId);
      transaction.set(eventRef.collection('boat_sessions').doc(boatId), {
        status: 'returned',
        passenger_count: Number.isInteger(boat.passenger_count) ? boat.passenger_count : 0,
        returned_at: FieldValue.serverTimestamp(), due_at: FieldValue.delete(),
        updated_at: FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.create(eventRef.collection('activity').doc(eventActivityRef.id), {
        action: 'return', boat_id: boatId, vessel_name: boat.vessel_name || boatId,
        passenger_count: Number.isInteger(boat.passenger_count) ? boat.passenger_count : 0,
        occurred_at: FieldValue.serverTimestamp()
      });
    }
    transaction.update(boatRef, {
      availability_status: 'available',
      tracking_enabled: false,
      booked: false,
      booked_by: FieldValue.delete(),
      renter_type: FieldValue.delete(),
      passenger_count: FieldValue.delete(),
      time_out: FieldValue.delete(),
      time_due_back: FieldValue.delete(),
      rental_type: FieldValue.delete(),
      rental_minutes: FieldValue.delete(),
      use_type: FieldValue.delete(),
      event_id: FieldValue.delete(),
      event_name: FieldValue.delete(),
      actual_time_back: FieldValue.delete(),
      battery_override_active: FieldValue.delete(),
      battery_cycle_trip_count: Number(boat.battery_cycle_trip_count || 0) + 1,
      battery_cycle_operating_minutes: Number(boat.battery_cycle_operating_minutes || 0)
        + (checkedOutAt ? Math.max(0, Math.round((checkedInAt - checkedOutAt) / 60000)) : 0),
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

module.exports.buildIdentityUpdate = buildIdentityUpdate;
module.exports.hashInvitationValue = hashInvitationValue;
module.exports.invitationReservationId = invitationReservationId;
module.exports.invitationIsActive = invitationIsActive;
module.exports.invitationBlocksEmail = invitationBlocksEmail;
module.exports.invitationMatchesUser = invitationMatchesUser;
module.exports.completeImmediateDeletion = completeImmediateDeletion;
module.exports.assertUsableInvitation = assertUsableInvitation;
module.exports.assertInvitationIdentity = assertInvitationIdentity;
module.exports.validateLifecycleRequest = validateLifecycleRequest;
module.exports.sendLifecycleEmail = sendLifecycleEmail;
module.exports.encryptLifecycleMessage = encryptLifecycleMessage;
module.exports.decryptLifecycleMessage = decryptLifecycleMessage;
module.exports.lifecycleJobExpired = lifecycleJobExpired;
module.exports.lifecycleNotificationExpired = lifecycleNotificationExpired;
module.exports.hasTotpFactor = hasTotpFactor;
module.exports.waitForTotpEnrollment = waitForTotpEnrollment;
module.exports.reportsActiveMfa = reportsActiveMfa;
module.exports.acceptUserInvitationRequest = acceptUserInvitationRequest;
module.exports.completeUserInvitationRequest = completeUserInvitationRequest;

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const userAdmin = require('../userAdmin');
const { buildIdentityUpdate, hashInvitationValue, invitationReservationId, invitationIsActive, invitationBlocksEmail, invitationMatchesUser, completeImmediateDeletion, assertUsableInvitation, assertInvitationIdentity, validateLifecycleRequest, sendLifecycleEmail, encryptLifecycleMessage, decryptLifecycleMessage, lifecycleJobExpired, lifecycleNotificationExpired, waitForTotpEnrollment, reportsActiveMfa, acceptUserInvitationRequest, completeUserInvitationRequest } = userAdmin;

const INVITATION_TOKEN = 'A'.repeat(43);

function invitationAcceptanceFixture(invitation, userRecord) {
  const invitationRef = { kind: 'invitation', id: hashInvitationValue(INVITATION_TOKEN) };
  const userRef = { kind: 'user', id: userRecord.uid };
  const writes = [];
  const snapshot = (reference) => reference.kind === 'invitation'
    ? { exists: true, id: invitationRef.id, data: () => invitation }
    : { exists: false };
  return {
    writes,
    auth: { async getUser() { return userRecord; } },
    db: {
      collection(name) {
        return { doc(id) { return name === 'user_invitations' ? invitationRef : { ...userRef, id }; } };
      },
      async runTransaction(handler) {
        return handler({
          async get(reference) { return snapshot(reference); },
          update(reference, values) { writes.push(['update', reference, values]); },
          set(reference, values) { writes.push(['set', reference, values]); }
        });
      }
    }
  };
}

test('identity update normalizes a corrected email and resets verification', () => {
  const update = buildIdentityUpdate(
    { email: 'wrong@example.org' },
    ' Correct@Example.org ',
    'Test User'
  );

  assert.equal(update.email, 'correct@example.org');
  assert.equal(update.emailChanged, true);
  assert.deepEqual(update.authUpdate, {
    email: 'correct@example.org',
    displayName: 'Test User',
    emailVerified: false
  });
});

test('identity update preserves verification when the email is unchanged', () => {
  const update = buildIdentityUpdate(
    { email: 'user@example.org' },
    'USER@example.org',
    ''
  );

  assert.equal(update.emailChanged, false);
  assert.equal(Object.hasOwn(update.authUpdate, 'emailVerified'), false);
});

test('identity update rejects a missing email', () => {
  assert.throws(
    () => buildIdentityUpdate({ email: 'user@example.org' }, '  ', 'Test User'),
    (error) => error.code === 'invalid-argument'
  );
});

test('invitation tokens are stored as deterministic hashes', () => {
  assert.equal(hashInvitationValue('invite-token'), 'f9e3c47d452a8fab2dc56ef07d766534cb2cd31c5f63de7107412acc65daa5b8');
});

test('invitation reservation identity normalizes email casing and whitespace', () => {
  assert.equal(invitationReservationId(' Person@Example.org '), invitationReservationId('person@example.org'));
  assert.notEqual(invitationReservationId('person@example.org'), invitationReservationId('other@example.org'));
});

test('only unexpired pending or reserved invitations block duplicates', () => {
  assert.equal(invitationIsActive({ status: 'pending', expiresAt: 2000 }, 1000), true);
  assert.equal(invitationIsActive({ status: 'reserved', expiresAt: 2000 }, 1000), true);
  assert.equal(invitationIsActive({ status: 'pending', expiresAt: 1000 }, 1000), false);
  assert.equal(invitationIsActive({ status: 'consumed', expiresAt: 2000 }, 1000), false);
  assert.equal(invitationBlocksEmail({ status: 'cancelling', expiresAt: 0 }, 1000), true);
});

test('invitation rejects expired and consumed records', () => {
  assert.doesNotThrow(() => assertUsableInvitation({ status: 'pending', expiresAt: Date.now() + 1000 }));
  assert.throws(() => assertUsableInvitation({ status: 'pending', expiresAt: Date.now() - 1 }), error => error.code === 'failed-precondition');
  assert.throws(() => assertUsableInvitation({ status: 'consumed', expiresAt: Date.now() + 1000 }), error => error.code === 'failed-precondition');
});

test('invitation identity requires verified matching email and bound uid', () => {
  const invitation = { email: 'person@example.org', status: 'reserved', reservedUid: 'user-1' };
  assert.doesNotThrow(() => assertInvitationIdentity(invitation, { uid: 'user-1', email: 'PERSON@example.org', emailVerified: true }));
  assert.throws(() => assertInvitationIdentity(invitation, { uid: 'user-1', email: 'other@example.org', emailVerified: true }), error => error.code === 'permission-denied');
  assert.throws(() => assertInvitationIdentity(invitation, { uid: 'user-1', email: 'person@example.org', emailVerified: false }), error => error.code === 'permission-denied');
  assert.throws(() => assertInvitationIdentity(invitation, { uid: 'user-2', email: 'person@example.org', emailVerified: true }), error => error.code === 'failed-precondition');
});

test('lifecycle confirmation requires the exact target email', () => {
  const user = { email: 'person@example.org' };
  assert.deepEqual(validateLifecycleRequest({ confirmationEmail: ' person@example.org ' }, user), { email: 'person@example.org', reason: '' });
  assert.throws(() => validateLifecycleRequest({ confirmationEmail: 'PERSON@example.org' }, user), error => error.code === 'failed-precondition');
  assert.throws(() => validateLifecycleRequest({ confirmationEmail: 'other@example.org' }, user), error => error.code === 'failed-precondition');
  assert.deepEqual(validateLifecycleRequest({ confirmationEmail: 'Person@Example.org' }, { email: 'Person@Example.org' }), { email: 'person@example.org', reason: '' });
  assert.throws(() => validateLifecycleRequest({ confirmationEmail: 'person@example.org' }, { email: 'Person@Example.org' }), error => error.code === 'failed-precondition');
});

test('suspension requires a bounded explanation', () => {
  const user = { email: 'person@example.org' };
  assert.equal(validateLifecycleRequest({ confirmationEmail: user.email, reason: 'Repeated policy violation.' }, user, true).reason, 'Repeated policy violation.');
  assert.throws(() => validateLifecycleRequest({ confirmationEmail: user.email, reason: 'Too short' }, user, true), error => error.code === 'invalid-argument');
  assert.throws(() => validateLifecycleRequest({ confirmationEmail: user.email, reason: 'x'.repeat(1001) }, user, true), error => error.code === 'invalid-argument');
});

test('lifecycle email uses authenticated Gmail SMTP without exposing credentials', async () => {
  const originalEmail = process.env.GMAIL_SENDER_EMAIL;
  const originalPassword = process.env.GMAIL_APP_PASSWORD;
  const appPassword = randomBytes(16).toString('hex');
  process.env.GMAIL_SENDER_EMAIL = 'poc.sender@gmail.com';
  process.env.GMAIL_APP_PASSWORD = appPassword;
  let message;
  try {
    await sendLifecycleEmail({ to: 'person@example.org', subject: 'Notice', text: 'Account notice.' }, {
      async sendMail(options) {
        message = options;
        return { accepted: [options.to] };
      }
    }, 'job-1');
  } finally {
    process.env.GMAIL_SENDER_EMAIL = originalEmail;
    process.env.GMAIL_APP_PASSWORD = originalPassword;
  }
  assert.equal(message.from, 'poc.sender@gmail.com');
  assert.equal(message.to, 'person@example.org');
  assert.equal(message.subject, 'Notice');
  assert.equal(message.text, 'Account notice.');
  assert.equal(message.headers['X-CWB-Lifecycle-Job'], 'job-1');
  assert.equal(JSON.stringify(message).includes(appPassword), false);
});

test('lifecycle notification content is encrypted at rest', () => {
  const originalKey = process.env.LIFECYCLE_NOTIFICATION_KEY;
  process.env.LIFECYCLE_NOTIFICATION_KEY = Buffer.alloc(32, 7).toString('base64');
  const message = { action: 'suspend', uid: 'user-1', email: 'person@example.org', reason: 'Policy explanation.' };
  try {
    const encrypted = encryptLifecycleMessage(message);
    assert.equal(JSON.stringify(encrypted).includes(message.email), false);
    assert.deepEqual(decryptLifecycleMessage(encrypted), message);
  } finally {
    process.env.LIFECYCLE_NOTIFICATION_KEY = originalKey;
  }
});

test('lifecycle jobs become ineligible for delivery at expiry', () => {
  const job = { expiresAt: { toMillis: () => 1000 } };
  assert.equal(lifecycleJobExpired(job, 999), false);
  assert.equal(lifecycleJobExpired(job, 1000), true);
});

test('only completed lifecycle jobs may expire before notification delivery', () => {
  const expiresAt = { toMillis: () => 1000 };
  assert.equal(lifecycleNotificationExpired({ expiresAt, operationCompleted: false }, 1000), false);
  assert.equal(lifecycleNotificationExpired({ expiresAt, operationCompleted: true }, 1000), true);
});

test('invitation completion waits for a newly enrolled TOTP factor to propagate', async () => {
  let reads = 0;
  let pauses = 0;
  const userRecord = await waitForTotpEnrollment(
    'user-1',
    async () => {
      reads += 1;
      return reads < 3
        ? { multiFactor: { enrolledFactors: [] } }
        : { multiFactor: { enrolledFactors: [{ factorId: 'totp' }] } };
    },
    async () => { pauses += 1; }
  );
  assert.equal(reads, 3);
  assert.equal(pauses, 2);
  assert.equal(userRecord.multiFactor.enrolledFactors[0].factorId, 'totp');
});

test('invitation completion fails closed when TOTP propagation never completes', async () => {
  let reads = 0;
  let pauses = 0;
  await assert.rejects(
    waitForTotpEnrollment(
      'user-1',
      async () => {
        reads += 1;
        return { multiFactor: { enrolledFactors: [] } };
      },
      async () => { pauses += 1; }
    ),
    error => error.code === 'failed-precondition'
  );
  assert.equal(reads, 6);
  assert.equal(pauses, 5);
});

test('admin reports MFA only for fully active accounts', () => {
  const enrolledUser = { multiFactor: { enrolledFactors: [{ factorId: 'totp' }] } };
  assert.equal(reportsActiveMfa(enrolledUser, { status: 'active' }, null), true);
  assert.equal(reportsActiveMfa(enrolledUser, { status: 'pending_mfa' }, { id: 'invite-1' }), false);
  assert.equal(reportsActiveMfa(enrolledUser, { status: 'active' }, { id: 'invite-1' }), false);
  assert.equal(reportsActiveMfa({ ...enrolledUser, disabled: true }, { status: 'active' }, null), false);
  assert.equal(reportsActiveMfa({ multiFactor: { enrolledFactors: [] } }, { status: 'active' }, null), false);
});

test('account deletion failures reject without entering the notification queue', async () => {
  let notificationQueued = false;
  await assert.rejects(
    completeImmediateDeletion(
      { action: 'delete', actorUid: 'admin-1', uid: 'user-1' },
      async () => { throw new Error('deletion failed'); },
      async () => { notificationQueued = true; }
    ),
    /deletion failed/
  );
  assert.equal(notificationQueued, false);
});

test('successful account deletion queues only a completed notification', async () => {
  const calls = [];
  const payload = { action: 'delete', actorUid: 'admin-1', uid: 'user-1' };
  const result = await completeImmediateDeletion(
    payload,
    async value => calls.push(['delete', value]),
    async (value, operationCompleted) => calls.push(['notify', value, operationCompleted])
  );
  assert.deepEqual(calls, [
    ['delete', payload],
    ['notify', payload, true]
  ]);
  assert.deepEqual(result, {
    operationCompleted: true,
    deleted: true,
    notificationQueued: true,
    notificationSent: false
  });
});

test('reserved invitations merge with the same Auth identity', () => {
  assert.equal(invitationMatchesUser(
    { reservedUid: 'user-1', email: 'old@example.org' },
    { uid: 'user-1', email: 'new@example.org' }
  ), true);
  assert.equal(invitationMatchesUser(
    { email: ' Person@Example.org ' },
    { uid: 'user-2', email: 'person@example.org' }
  ), true);
  assert.equal(invitationMatchesUser(
    { reservedUid: 'user-3', email: 'other@example.org' },
    { uid: 'user-2', email: 'person@example.org' }
  ), false);
});

test('pending MFA invitations remain associated with their Auth identity', () => {
  const invitation = { status: 'reserved', reservedUid: 'pending-user', email: 'person@example.org' };
  assert.equal(invitationMatchesUser(invitation, { uid: 'pending-user', email: 'person@example.org' }), true);
});

test('invitation callable exports reject missing authentication and malformed tokens', async () => {
  await assert.rejects(
    userAdmin.acceptUserInvitation.run({ data: { token: INVITATION_TOKEN } }),
    error => error.code === 'unauthenticated'
  );
  await assert.rejects(
    userAdmin.completeUserInvitation.run({ auth: { uid: 'user-1' }, data: { token: 'short' } }),
    error => error.code === 'failed-precondition'
  );
});

test('invitation acceptance rejects an unverified or mismatched mailbox identity', async () => {
  const invitation = { email: 'invited@example.org', status: 'pending', expiresAt: Date.now() + 10000 };
  for (const userRecord of [
    { uid: 'user-1', email: 'invited@example.org', emailVerified: false },
    { uid: 'user-1', email: 'other@example.org', emailVerified: true }
  ]) {
    const fixture = invitationAcceptanceFixture(invitation, userRecord);
    await assert.rejects(
      acceptUserInvitationRequest({ auth: { uid: 'user-1' }, data: { token: INVITATION_TOKEN } }, fixture),
      error => error.code === 'permission-denied'
    );
    assert.equal(fixture.writes.length, 0);
  }
});

test('invitation acceptance rejects a competing UID reservation', async () => {
  const fixture = invitationAcceptanceFixture({
    email: 'invited@example.org', status: 'reserved', reservedUid: 'other-user',
    expiresAt: Date.now() + 10000
  }, { uid: 'user-1', email: 'invited@example.org', emailVerified: true });
  await assert.rejects(
    acceptUserInvitationRequest({ auth: { uid: 'user-1' }, data: { token: INVITATION_TOKEN } }, fixture),
    error => error.code === 'failed-precondition'
  );
  assert.equal(fixture.writes.length, 0);
});

test('invitation acceptance reserves the verified identity and creates its pending profile', async () => {
  const fixture = invitationAcceptanceFixture({
    email: 'invited@example.org', displayName: 'Invited User', status: 'pending',
    expiresAt: Date.now() + 10000
  }, { uid: 'user-1', email: 'invited@example.org', emailVerified: true });
  const result = await acceptUserInvitationRequest(
    { auth: { uid: 'user-1' }, data: { token: INVITATION_TOKEN } },
    fixture
  );
  assert.deepEqual(result, { accepted: true, email: 'invited@example.org' });
  assert.equal(fixture.writes.filter(([operation]) => operation === 'update').length, 1);
  assert.equal(fixture.writes.filter(([operation]) => operation === 'set').length, 1);
});

test('invitation completion fails before persistence when TOTP is absent', async () => {
  await assert.rejects(
    completeUserInvitationRequest(
      { auth: { uid: 'user-1' }, data: { token: INVITATION_TOKEN } },
      { waitForTotpEnrollment: async () => { throw Object.assign(new Error('No TOTP'), { code: 'failed-precondition' }); } }
    ),
    error => error.code === 'failed-precondition'
  );
});

test('invitation completion clears claims when profile activation fails', async () => {
  const invitation = {
    email: 'invited@example.org', status: 'reserved', reservedUid: 'user-1', role: 'staff',
    functionLevel: 'operations', expiresAt: Date.now() + 10000
  };
  const clearedClaims = [];
  const invitationRef = { async get() { return { exists: true, data: () => invitation }; } };
  await assert.rejects(
    completeUserInvitationRequest(
      { auth: { uid: 'user-1' }, data: { token: INVITATION_TOKEN } },
      {
        db: {
          collection() { return { doc() { return invitationRef; } }; },
          async runTransaction() { throw new Error('activation write failed'); }
        },
        auth: {
          async setCustomUserClaims(uid, claims) { clearedClaims.push([uid, claims]); },
          async revokeRefreshTokens() { throw new Error('must not revoke after failed activation'); }
        },
        waitForTotpEnrollment: async () => ({
          uid: 'user-1', email: 'invited@example.org', emailVerified: true,
          multiFactor: { enrolledFactors: [{ factorId: 'totp' }] }
        }),
        applyClaims: async () => {}
      }
    ),
    /activation write failed/
  );
  assert.deepEqual(clearedClaims, [['user-1', {}]]);
});
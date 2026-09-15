const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { buildIdentityUpdate, hashInvitationValue, assertUsableInvitation, assertInvitationIdentity, validateLifecycleRequest, sendLifecycleEmail, encryptLifecycleMessage, decryptLifecycleMessage, lifecycleJobExpired } = require('../userAdmin');

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
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireAuthenticatedUser, requireMfaAdmin, requireMfaOperations } = require('../authGuards');

function expectCode(callback, code) {
  return assert.rejects(callback, (error) => error.code === code);
}

const ACTIVE_USER = { email: 'user@cwb.org', disabled: false, tokensValidAfterTime: '2026-01-01T00:00:00.000Z' };
const ACTIVE_TOKEN = {
  auth_time: 1767225601,
  email: 'user@cwb.org',
  email_verified: true,
  firebase: { sign_in_second_factor: 'totp' }
};
const adminProfile = { email: 'user@cwb.org', status: 'active', role: 'admin', functionLevel: 'operations' };
const staffProfile = { email: 'user@cwb.org', status: 'active', role: 'staff', functionLevel: 'operations' };

test('authenticated-user guard rejects anonymous requests', async () => {
  await expectCode(async () => requireAuthenticatedUser({}), 'unauthenticated');
});

test('authenticated-user guard accepts a Firebase-authenticated request', () => {
  const auth = { uid: 'user-1', token: {} };
  assert.equal(requireAuthenticatedUser({ auth }), auth);
});

test('MFA-admin guard rejects a non-admin', async () => {
  await expectCode(
    () => requireMfaAdmin({ auth: { uid: 'user-1', token: {} } }),
    'permission-denied'
  );
});

test('MFA-admin guard rejects an admin without TOTP', async () => {
  await expectCode(
    () => requireMfaAdmin({ auth: { uid: 'admin-1', token: { admin: true, role: 'admin' } } }),
    'failed-precondition'
  );
});

test('MFA-admin guard accepts an admin with TOTP', async () => {
  const auth = {
    uid: 'admin-1', token: { ...ACTIVE_TOKEN, admin: true, role: 'admin', functionLevel: 'operations' }
  };
  assert.equal(await requireMfaAdmin({ auth }, async () => ACTIVE_USER, async () => adminProfile), auth);
});

test('MFA-operations guard accepts operations staff with TOTP', async () => {
  const auth = {
    uid: 'staff-1', token: { ...ACTIVE_TOKEN, role: 'staff', functionLevel: 'operations' }
  };
  assert.equal(await requireMfaOperations({ auth }, async () => ACTIVE_USER, async () => staffProfile), auth);
});

test('MFA-operations guard rejects volunteers and missing TOTP', async () => {
  await expectCode(
    () => requireMfaOperations({ auth: { uid: 'volunteer-1', token: { role: 'volunteer', functionLevel: 'operations', firebase: { sign_in_second_factor: 'totp' } } } }),
    'permission-denied'
  );
  await expectCode(
    () => requireMfaOperations({ auth: { uid: 'staff-1', token: { role: 'staff', functionLevel: 'operations' } } }),
    'failed-precondition'
  );
});

test('MFA-admin guard rejects disagreeing admin claims', async () => {
  await expectCode(
    () => requireMfaAdmin({ auth: { uid: 'admin-1', token: { ...ACTIVE_TOKEN, role: 'admin' } } }),
    'permission-denied'
  );
  await expectCode(
    () => requireMfaAdmin({ auth: { uid: 'admin-1', token: { ...ACTIVE_TOKEN, admin: true } } }),
    'permission-denied'
  );
});

test('MFA-admin guard rejects disabled and revoked sessions', async () => {
  const auth = { uid: 'admin-1', token: { ...ACTIVE_TOKEN, admin: true, role: 'admin', functionLevel: 'operations' } };
  await expectCode(
    () => requireMfaAdmin({ auth }, async () => ({ ...ACTIVE_USER, disabled: true })),
    'unauthenticated'
  );
  await expectCode(
    () => requireMfaAdmin({ auth }, async () => ({ ...ACTIVE_USER, tokensValidAfterTime: '2026-01-01T00:00:02.000Z' })),
    'unauthenticated'
  );
  await expectCode(
    () => requireMfaAdmin({ auth }, async () => { throw new Error('user-not-found'); }),
    'unauthenticated'
  );
});

test('MFA guards reject pending and mismatched live profiles', async () => {
  const auth = { uid: 'staff-1', token: { ...ACTIVE_TOKEN, role: 'staff', functionLevel: 'operations' } };
  await expectCode(
    () => requireMfaOperations({ auth }, async () => ACTIVE_USER, async () => ({ ...staffProfile, status: 'pending_mfa' })),
    'unauthenticated'
  );
  await expectCode(
    () => requireMfaOperations({ auth }, async () => ACTIVE_USER, async () => ({ ...staffProfile, email: 'other@cwb.org' })),
    'unauthenticated'
  );
  await expectCode(
    () => requireMfaOperations({ auth }, async () => ACTIVE_USER, async () => ({ ...staffProfile, role: 'manager' })),
    'unauthenticated'
  );
  await expectCode(
    () => requireMfaOperations({ auth: { ...auth, token: { ...auth.token, email: 'other@cwb.org' } } }, async () => ACTIVE_USER, async () => staffProfile),
    'unauthenticated'
  );
  await expectCode(
    () => requireMfaOperations({ auth: { ...auth, token: { ...auth.token, email_verified: false } } }, async () => ACTIVE_USER, async () => staffProfile),
    'unauthenticated'
  );
});
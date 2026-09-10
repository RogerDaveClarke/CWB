const test = require('node:test');
const assert = require('node:assert/strict');
const { requireAuthenticatedUser, requireMfaAdmin, requireMfaOperations } = require('../authGuards');

function expectCode(callback, code) {
  return assert.rejects(callback, (error) => error.code === code);
}

const ACTIVE_USER = { disabled: false, tokensValidAfterTime: '2026-01-01T00:00:00.000Z' };
const ACTIVE_TOKEN = { auth_time: 1767225601, firebase: { sign_in_second_factor: 'totp' } };

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
    () => requireMfaAdmin({ auth: { uid: 'admin-1', token: { admin: true } } }),
    'failed-precondition'
  );
});

test('MFA-admin guard accepts an admin with TOTP', async () => {
  const auth = {
    uid: 'admin-1', token: { ...ACTIVE_TOKEN, admin: true }
  };
  assert.equal(await requireMfaAdmin({ auth }, async () => ACTIVE_USER), auth);
});

test('MFA-operations guard accepts operations staff with TOTP', async () => {
  const auth = {
    uid: 'staff-1', token: { ...ACTIVE_TOKEN, role: 'staff', functionLevel: 'operations' }
  };
  assert.equal(await requireMfaOperations({ auth }, async () => ACTIVE_USER), auth);
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

test('MFA-admin guard accepts an admin role with TOTP', async () => {
  const auth = {
    uid: 'admin-1', token: { ...ACTIVE_TOKEN, role: 'admin' }
  };
  assert.equal(await requireMfaAdmin({ auth }, async () => ACTIVE_USER), auth);
});

test('MFA-admin guard rejects disabled and revoked sessions', async () => {
  const auth = { uid: 'admin-1', token: { ...ACTIVE_TOKEN, admin: true } };
  await expectCode(
    () => requireMfaAdmin({ auth }, async () => ({ ...ACTIVE_USER, disabled: true })),
    'unauthenticated'
  );
  await expectCode(
    () => requireMfaAdmin({ auth }, async () => ({ ...ACTIVE_USER, tokensValidAfterTime: '2026-01-01T00:00:02.000Z' })),
    'unauthenticated'
  );
});
const test = require('node:test');
const assert = require('node:assert/strict');
const { identityMismatch } = require('../identityReconciliation');

const activeStaff = { disabled: false, customClaims: { role: 'staff', functionLevel: 'operations' } };

test('identity reconciliation accepts matching active state', () => {
  assert.equal(identityMismatch(activeStaff, { status: 'active', role: 'staff', functionLevel: 'operations' }), null);
});

test('identity reconciliation detects lifecycle and claim drift', () => {
  assert.equal(identityMismatch(activeStaff, null), 'missing-profile');
  assert.equal(identityMismatch({ ...activeStaff, disabled: true }, { status: 'active', role: 'staff', functionLevel: 'operations' }), 'disabled-status-mismatch');
  assert.equal(identityMismatch(activeStaff, { status: 'active', role: 'manager', functionLevel: 'operations' }), 'role-claim-mismatch');
  assert.equal(identityMismatch({ disabled: false, customClaims: { role: 'admin', functionLevel: 'administration' } }, { status: 'active', role: 'admin', functionLevel: 'administration' }), 'admin-claim-mismatch');
});
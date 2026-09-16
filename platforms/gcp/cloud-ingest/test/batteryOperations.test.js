const test = require('node:test');
const assert = require('node:assert/strict');
const { checkoutInput, requiredBoatId } = require('../batteryOperations');

test('normalizes valid boat IDs', () => {
  assert.equal(requiredBoatId('70B3D57ED0000001'), '70b3d57ed0000001');
  assert.throws(() => requiredBoatId('boat-1'), error => error.code === 'invalid-argument');
});

test('validates battery-aware checkout input', () => {
  assert.deepEqual(checkoutInput({
    boatId: '70b3d57ed0000001', renterName: ' Test Renter ', renterType: 'Public',
    passengerCount: 2, overrideReason: 'Management approved this trip.'
  }), {
    boatId: '70b3d57ed0000001', renterName: 'Test Renter', renterType: 'Public',
    passengerCount: 2, overrideReason: 'Management approved this trip.'
  });
  assert.throws(() => checkoutInput({ boatId: '70b3d57ed0000001', renterName: '', renterType: 'Public', passengerCount: 2 }), error => error.code === 'invalid-argument');
  assert.throws(() => checkoutInput({ boatId: '70b3d57ed0000001', renterName: 'Renter', renterType: 'Other', passengerCount: 2 }), error => error.code === 'invalid-argument');
});
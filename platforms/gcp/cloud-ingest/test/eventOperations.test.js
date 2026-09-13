const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEventInput, validateDepartureInput } = require('../eventOperations');

test('event input accepts unique valid boats and bounded duration', () => {
  const result = validateEventInput({
    name: 'Sunday Public Sail', eventTypeId: 'public-sail', startsAt: '2026-09-13T12:30:00-07:00',
    defaultDurationMinutes: 45, boatIds: ['70b3d57ed0000001', '70b3d57ed0000001', '70b3d57ed0000002']
  });
  assert.equal(result.name, 'Sunday Public Sail');
  assert.deepEqual(result.boatIds, ['70b3d57ed0000001', '70b3d57ed0000002']);
});

test('event input rejects empty boat assignments', () => {
  assert.throws(() => validateEventInput({ name: 'Event', eventTypeId: 'type', startsAt: new Date(), defaultDurationMinutes: 60, boatIds: [] }), error => error.code === 'invalid-argument');
});

test('departure input validates operational and identity fields', () => {
  const result = validateDepartureInput({ eventId: 'event-1', boatId: '70b3d57ed0000001', responsibleName: 'Dock Lead', participationType: 'CWB staff', passengerCount: 3, durationMinutes: 60 });
  assert.equal(result.passengerCount, 3);
  assert.throws(() => validateDepartureInput({ ...result, passengerCount: 13 }), error => error.code === 'invalid-argument');
  assert.throws(() => validateDepartureInput({ ...result, participationType: 'Unknown' }), error => error.code === 'invalid-argument');
});
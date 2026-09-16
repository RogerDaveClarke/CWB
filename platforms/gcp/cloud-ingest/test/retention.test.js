const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteExpiredBatteryEventBatch, retentionCutoff } = require('../retention');

test('GPS trail retention cutoff is exactly two days', () => {
  const now = Date.UTC(2026, 8, 10, 12, 0, 0);
  assert.equal(retentionCutoff(now).toMillis(), now - 2 * 24 * 60 * 60 * 1000);
});

test('battery event retention deletes the expired query batch', async () => {
  const deleted = [];
  const documents = [{ ref: { path: 'battery_service_events/event-1' } }, { ref: { path: 'battery_service_events/event-2' } }];
  const query = {
    where(field, operator) { assert.equal(field, 'expires_at'); assert.equal(operator, '<'); return this; },
    limit(value) { assert.equal(value, 200); return this; },
    async get() { return { empty: false, size: documents.length, docs: documents }; }
  };
  const db = {
    collection(name) { assert.equal(name, 'battery_service_events'); return query; },
    batch() { return { delete(ref) { deleted.push(ref.path); }, async commit() {} }; }
  };

  assert.equal(await deleteExpiredBatteryEventBatch(db), 2);
  assert.deepEqual(deleted, ['battery_service_events/event-1', 'battery_service_events/event-2']);
});
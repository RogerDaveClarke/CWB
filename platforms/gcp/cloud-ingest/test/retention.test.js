const test = require('node:test');
const assert = require('node:assert/strict');
const { retentionCutoff } = require('../retention');

test('GPS trail retention cutoff is exactly two days', () => {
  const now = Date.UTC(2026, 8, 10, 12, 0, 0);
  assert.equal(retentionCutoff(now).toMillis(), now - 2 * 24 * 60 * 60 * 1000);
});
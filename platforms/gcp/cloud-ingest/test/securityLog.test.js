const test = require('node:test');
const assert = require('node:assert/strict');
const { pseudonymousId } = require('../securityLog');

test('security log identifiers are stable hashes and never raw identifiers', () => {
  const raw = 'user@example.org';
  const value = pseudonymousId(raw);
  assert.equal(value.length, 16);
  assert.notEqual(value, raw);
  assert.equal(value, pseudonymousId(raw));
});
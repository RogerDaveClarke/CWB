const test = require('node:test');
const assert = require('node:assert/strict');
const { batteryHealth, batteryVerificationProgress, checkoutBatteryDecision } = require('../batteryPolicy');

test('classifies total four-cell NiCd pack voltage at exact boundaries', () => {
  assert.equal(batteryHealth(0), 'unknown');
  assert.equal(batteryHealth(4000), 'critical');
  assert.equal(batteryHealth(4001), 'red');
  assert.equal(batteryHealth(4400), 'red');
  assert.equal(batteryHealth(4401), 'amber');
  assert.equal(batteryHealth(4800), 'amber');
  assert.equal(batteryHealth(4801), 'green');
  assert.equal(batteryHealth(7001), 'unknown');
});

test('blocks charging, verification, unknown, and critical batteries', () => {
  const readingTimestamp = new Date();
  assert.equal(checkoutBatteryDecision({ millivolts: 5000, readingTimestamp, serviceStatus: 'charging' }).reason, 'battery-charging');
  assert.equal(checkoutBatteryDecision({ millivolts: 5000, readingTimestamp, serviceStatus: 'verification' }).reason, 'battery-verification');
  assert.equal(checkoutBatteryDecision({ millivolts: 5000, readingTimestamp, serviceStatus: 'removed' }).reason, 'battery-service-unverified');
  assert.equal(checkoutBatteryDecision({ millivolts: 0, readingTimestamp, serviceStatus: 'ready' }).reason, 'battery-unverified');
  assert.equal(checkoutBatteryDecision({ millivolts: 4000, readingTimestamp, serviceStatus: 'ready', role: 'admin', isAdmin: true, overrideReason: 'operational-necessity' }).reason, 'battery-critical');
});

test('allows amber and green batteries without an override', () => {
  const readingTimestamp = new Date();
  assert.deepEqual(checkoutBatteryDecision({ millivolts: 4401, readingTimestamp, serviceStatus: 'ready', role: 'staff' }), { allowed: true, health: 'amber', override: false });
  assert.deepEqual(checkoutBatteryDecision({ millivolts: 5000, readingTimestamp, serviceStatus: 'ready', role: 'staff' }), { allowed: true, health: 'green', override: false });
});

test('allows only explicitly pre-device boats to bypass telemetry checks', () => {
  assert.deepEqual(checkoutBatteryDecision({ millivolts: 0, monitoringEnabled: false, role: 'staff' }), { allowed: true, health: 'unknown', override: false });
  assert.equal(checkoutBatteryDecision({ millivolts: 0, role: 'staff' }).reason, 'battery-service-unverified');
});

test('red batteries require an approved manager or administrator reason code', () => {
  const readingTimestamp = new Date();
  assert.equal(checkoutBatteryDecision({ millivolts: 4300, readingTimestamp, serviceStatus: 'ready', role: 'staff', overrideReason: 'operational-necessity' }).reason, 'management-override-required');
  assert.equal(checkoutBatteryDecision({ millivolts: 4300, readingTimestamp, serviceStatus: 'ready', role: 'manager', overrideReason: 'renter requested it' }).reason, 'override-reason-required');
  assert.deepEqual(
    checkoutBatteryDecision({ millivolts: 4300, readingTimestamp, serviceStatus: 'ready', role: 'manager', overrideReason: ' operational-necessity ' }),
    { allowed: true, health: 'red', override: true, overrideReason: 'operational-necessity' }
  );
});

test('rejects stale, future, missing, and physically implausible readings', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  assert.equal(checkoutBatteryDecision({ millivolts: 5000, serviceStatus: 'ready', now }).reason, 'battery-reading-stale');
  assert.equal(checkoutBatteryDecision({ millivolts: 5000, readingTimestamp: now - 15 * 60 * 1000 - 1, serviceStatus: 'ready', now }).reason, 'battery-reading-stale');
  assert.equal(checkoutBatteryDecision({ millivolts: 5000, readingTimestamp: now + 1, serviceStatus: 'ready', now }).reason, 'battery-reading-stale');
  assert.equal(checkoutBatteryDecision({ millivolts: 65535, readingTimestamp: now, serviceStatus: 'ready', now }).reason, 'battery-unverified');
});

test('verification accepts only increasing post-installation frame counters', () => {
  assert.deepEqual(batteryVerificationProgress({ health: 'green', frameCounter: 10, afterFrameCounter: 10, lastFrameCounter: 10, count: 0 }), { accepted: false, count: 0, complete: false });
  assert.deepEqual(batteryVerificationProgress({ health: 'green', frameCounter: 9, afterFrameCounter: 10, lastFrameCounter: 10, count: 0 }), { accepted: false, count: 0, complete: false });
  assert.deepEqual(batteryVerificationProgress({ health: 'green', frameCounter: 11, afterFrameCounter: 10, lastFrameCounter: 10, count: 0 }), { accepted: true, count: 1, complete: false });
  assert.deepEqual(batteryVerificationProgress({ health: 'amber', frameCounter: 12, afterFrameCounter: 10, lastFrameCounter: 11, count: 1 }), { accepted: true, count: 0, complete: false });
  assert.deepEqual(batteryVerificationProgress({ health: 'green', frameCounter: 13, afterFrameCounter: 10, lastFrameCounter: 12, count: 2 }), { accepted: true, count: 3, complete: true });
});
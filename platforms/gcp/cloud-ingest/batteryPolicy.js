const BATTERY_AMBER_MV = 4800;
const BATTERY_RED_MV = 4400;
const BATTERY_CRITICAL_MV = 4000;
const BATTERY_MAX_PLAUSIBLE_MV = 7000;
const BATTERY_READING_MAX_AGE_MS = 15 * 60 * 1000;
const BATTERY_VERIFICATION_READINGS = 3;
const BATTERY_OVERRIDE_REASONS = new Set(['operational-necessity', 'scheduled-event', 'service-evaluation']);

function batteryHealth(millivolts) {
  const voltage = Number(millivolts);
  if (!Number.isFinite(voltage) || voltage <= 0 || voltage > BATTERY_MAX_PLAUSIBLE_MV) return 'unknown';
  if (voltage <= BATTERY_CRITICAL_MV) return 'critical';
  if (voltage <= BATTERY_RED_MV) return 'red';
  if (voltage <= BATTERY_AMBER_MV) return 'amber';
  return 'green';
}

function timestampMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Number.NaN;
}

function checkoutBatteryDecision({ millivolts, readingTimestamp, now = Date.now(), serviceStatus, role, isAdmin = false, overrideReason = '' }) {
  const health = batteryHealth(millivolts);
  if (serviceStatus !== 'ready') return { allowed: false, health, reason: serviceStatus === 'charging' ? 'battery-charging' : serviceStatus === 'verification' ? 'battery-verification' : 'battery-service-unverified' };
  if (health === 'unknown') return { allowed: false, health, reason: 'battery-unverified' };
  const readingAt = timestampMillis(readingTimestamp);
  if (!Number.isFinite(readingAt) || readingAt > now || now - readingAt > BATTERY_READING_MAX_AGE_MS) {
    return { allowed: false, health, reason: 'battery-reading-stale' };
  }
  if (health === 'critical') return { allowed: false, health, reason: 'battery-critical' };
  if (health !== 'red') return { allowed: true, health, override: false };

  const normalizedReason = typeof overrideReason === 'string' ? overrideReason.trim() : '';
  const canOverride = isAdmin || role === 'manager';
  if (!canOverride) return { allowed: false, health, reason: 'management-override-required' };
  if (!BATTERY_OVERRIDE_REASONS.has(normalizedReason)) return { allowed: false, health, reason: 'override-reason-required' };
  return { allowed: true, health, override: true, overrideReason: normalizedReason };
}

function batteryVerificationProgress({ health, frameCounter, afterFrameCounter, lastFrameCounter, count = 0 }) {
  const validCounters = [frameCounter, afterFrameCounter, lastFrameCounter].every(value => Number.isSafeInteger(value) && value >= 0);
  if (!validCounters || frameCounter <= afterFrameCounter || frameCounter <= lastFrameCounter) {
    return { accepted: false, count, complete: false };
  }
  const nextCount = health === 'green' ? count + 1 : 0;
  return { accepted: true, count: nextCount, complete: nextCount >= BATTERY_VERIFICATION_READINGS };
}

module.exports = {
  BATTERY_AMBER_MV,
  BATTERY_RED_MV,
  BATTERY_CRITICAL_MV,
  BATTERY_MAX_PLAUSIBLE_MV,
  BATTERY_READING_MAX_AGE_MS,
  BATTERY_VERIFICATION_READINGS,
  BATTERY_OVERRIDE_REASONS,
  batteryHealth,
  checkoutBatteryDecision,
  batteryVerificationProgress
};
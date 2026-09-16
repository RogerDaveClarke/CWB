const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_BODY_BYTES,
  RATE_LIMIT_REQUESTS,
  authenticateWebhookRequest,
  buildIngestEventId,
  normalizeDeviceId,
  resetRateLimits
} = require('../webhookAuth');

const TOKEN = 'test-webhook-token';

function request(overrides = {}) {
  const headers = {
    'content-type': 'application/json',
    'x-cwb-webhook-token': TOKEN,
    ...overrides.headers
  };
  return {
    method: 'POST',
    ip: '192.0.2.1',
    rawBody: Buffer.from('{}'),
    get: (name) => headers[name.toLowerCase()],
    ...overrides,
    headers
  };
}

test.beforeEach(resetRateLimits);

test('rejects an unconfigured webhook secret', () => {
  assert.equal(authenticateWebhookRequest(request(), '').status, 500);
});

test('rejects missing and invalid credentials', () => {
  assert.equal(authenticateWebhookRequest(request({ headers: { 'x-cwb-webhook-token': undefined } }), TOKEN).status, 403);
  assert.equal(authenticateWebhookRequest(request({ headers: { 'x-cwb-webhook-token': 'wrong' } }), TOKEN).status, 403);
});

test('accepts a valid credential', () => {
  assert.deepEqual(authenticateWebhookRequest(request(), TOKEN), { ok: true });
});

test('normalizes valid mixed-case device identities', () => {
  assert.equal(normalizeDeviceId('70B3D57ED0000001'), '70b3d57ed0000001');
  assert.equal(normalizeDeviceId('not-a-device'), null);
});

test('fallback replay identity is stable across device casing and request formatting', () => {
  const payload = Buffer.from('01020304', 'hex');
  const event = { eventType: 'up', frameCounter: 42, payload };
  const uppercaseId = buildIngestEventId({ ...event, boatId: normalizeDeviceId('70B3D57ED0000001') });
  const lowercaseId = buildIngestEventId({ ...event, boatId: normalizeDeviceId('70b3d57ed0000001') });
  assert.equal(uppercaseId, lowercaseId);
  assert.notEqual(uppercaseId, buildIngestEventId({ ...event, boatId: normalizeDeviceId('70b3d57ed0000001'), frameCounter: 43 }));
});

test('requires POST with a JSON body', () => {
  assert.equal(authenticateWebhookRequest(request({ method: 'GET' }), TOKEN).status, 405);
  assert.equal(authenticateWebhookRequest(request({ headers: { 'content-type': 'text/plain' } }), TOKEN).status, 415);
  assert.equal(authenticateWebhookRequest(request({ headers: { 'content-type': 'application/jsonp' } }), TOKEN).status, 415);
  assert.equal(authenticateWebhookRequest(request({ headers: { 'content-type': 'application/json; charset=utf-8' } }), TOKEN).ok, true);
});

test('rejects oversized bodies', () => {
  const oversized = request({ rawBody: Buffer.alloc(MAX_BODY_BYTES + 1) });
  assert.equal(authenticateWebhookRequest(oversized, TOKEN).status, 413);
  const claimedOversized = request({ headers: { 'content-length': String(MAX_BODY_BYTES + 1) } });
  assert.equal(authenticateWebhookRequest(claimedOversized, TOKEN).status, 413);
});

test('fails closed when the raw body size or request origin cannot be verified', () => {
  assert.equal(authenticateWebhookRequest(request({ rawBody: undefined }), TOKEN).status, 400);
  assert.equal(authenticateWebhookRequest(request({ headers: { 'content-length': 'invalid' } }), TOKEN).status, 400);
  assert.equal(authenticateWebhookRequest(request({ ip: undefined, headers: { 'x-forwarded-for': '192.0.2.2' } }), TOKEN).status, 400);
});

test('invalid credentials do not exhaust a valid sender rate limit', () => {
  const firstRequestAt = 1000;
  for (let count = 0; count < RATE_LIMIT_REQUESTS + 1; count += 1) {
    assert.equal(
      authenticateWebhookRequest(request({ headers: { 'x-cwb-webhook-token': 'wrong' } }), TOKEN, firstRequestAt).status,
      403
    );
  }
  assert.equal(authenticateWebhookRequest(request(), TOKEN, firstRequestAt).ok, true);
});

test('throttles repeated requests from one client', () => {
  const firstRequestAt = 1000;
  for (let count = 0; count < RATE_LIMIT_REQUESTS; count += 1) {
    assert.equal(authenticateWebhookRequest(request(), TOKEN, firstRequestAt).ok, true);
  }
  assert.equal(authenticateWebhookRequest(request(), TOKEN, firstRequestAt).status, 429);
  assert.equal(authenticateWebhookRequest(request(), TOKEN, firstRequestAt + 60_000).ok, true);
});
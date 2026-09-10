const { createHash, timingSafeEqual } = require('node:crypto');

const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_REQUESTS = 120;
const requestWindows = new Map();

function reject(status, message, headers = {}) {
  return { ok: false, status, message, headers };
}

function tokenMatches(suppliedToken, expectedToken) {
  if (typeof suppliedToken !== 'string' || typeof expectedToken !== 'string') return false;
  const supplied = createHash('sha256').update(suppliedToken, 'utf8').digest();
  const expected = createHash('sha256').update(expectedToken, 'utf8').digest();
  return timingSafeEqual(supplied, expected);
}

function withinRateLimit(clientId, now) {
  const current = requestWindows.get(clientId);
  if (!current || now - current.startedAt >= RATE_LIMIT_WINDOW_MS) {
    requestWindows.set(clientId, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= RATE_LIMIT_REQUESTS;
}

function authenticateWebhookRequest(request, expectedToken, now = Date.now()) {
  if (request.method !== 'POST') {
    return reject(405, 'Method not allowed.', { Allow: 'POST' });
  }

  const contentType = String(request.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return reject(415, 'Content-Type must be application/json.');
  }

  if (!Buffer.isBuffer(request.rawBody)) {
    return reject(400, 'Unable to verify request body size.');
  }
  const contentLengthHeader = request.get('content-length');
  const contentLength = contentLengthHeader === undefined ? request.rawBody.length : Number(contentLengthHeader);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    return reject(400, 'Invalid Content-Length header.');
  }
  if (request.rawBody.length > MAX_BODY_BYTES || contentLength > MAX_BODY_BYTES) {
    return reject(413, 'Request body is too large.');
  }

  if (!expectedToken) {
    return reject(500, 'Webhook authentication is not configured.');
  }
  if (!tokenMatches(request.get('x-cwb-webhook-token'), expectedToken)) {
    return reject(403, 'Forbidden.');
  }

  const clientId = typeof request.ip === 'string' ? request.ip.trim() : '';
  if (!clientId) {
    return reject(400, 'Unable to determine request origin.');
  }
  if (!withinRateLimit(clientId, now)) {
    return reject(429, 'Too many requests.', { 'Retry-After': '60' });
  }

  return { ok: true };
}

function resetRateLimits() {
  requestWindows.clear();
}

module.exports = {
  MAX_BODY_BYTES,
  RATE_LIMIT_REQUESTS,
  authenticateWebhookRequest,
  resetRateLimits,
  tokenMatches
};
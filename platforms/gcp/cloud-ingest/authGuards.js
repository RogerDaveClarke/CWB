const { HttpsError } = require('firebase-functions/v2/https');
const { getAuth } = require('firebase-admin/auth');
const { logSecurityEvent, pseudonymousId } = require('./securityLog');

function requireAuthenticatedUser(request) {
  if (!request.auth) {
    logSecurityEvent('callable_auth_denied', { reason: 'unauthenticated' }, 'WARNING');
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  return request.auth;
}

async function requireActiveSession(auth, loadUser = (uid) => getAuth().getUser(uid)) {
  let user;
  try {
    user = await loadUser(auth.uid);
  } catch {
    logSecurityEvent('callable_auth_denied', { reason: 'user_deleted', actor: pseudonymousId(auth.uid) }, 'WARNING');
    throw new HttpsError('unauthenticated', 'Sign in again.');
  }
  const authenticatedAt = Number(auth.token?.auth_time) * 1000;
  const tokensValidAfter = Date.parse(user.tokensValidAfterTime || '');
  if (user.disabled || !Number.isFinite(authenticatedAt) || !Number.isFinite(tokensValidAfter)
      || authenticatedAt < tokensValidAfter) {
    logSecurityEvent('callable_auth_denied', { reason: 'session_revoked', actor: pseudonymousId(auth.uid) }, 'WARNING');
    throw new HttpsError('unauthenticated', 'Sign in again.');
  }
  return auth;
}

async function requireMfaAdmin(request, loadUser) {
  const auth = requireAuthenticatedUser(request);
  const token = auth.token || {};
  if (!(token.admin === true || token.role === 'admin')) {
    logSecurityEvent('callable_auth_denied', { reason: 'admin_required', actor: pseudonymousId(auth.uid) }, 'WARNING');
    throw new HttpsError('permission-denied', 'Administrator role required.');
  }
  if (token.firebase?.sign_in_second_factor !== 'totp') {
    logSecurityEvent('callable_auth_denied', { reason: 'mfa_required', actor: pseudonymousId(auth.uid) }, 'WARNING');
    throw new HttpsError('failed-precondition', 'Two-factor authentication required.');
  }
  return requireActiveSession(auth, loadUser);
}

async function requireMfaOperations(request, loadUser) {
  const auth = requireAuthenticatedUser(request);
  const token = auth.token || {};
  const hasOperationsRole = token.admin === true
    || token.role === 'admin'
    || (['manager', 'staff'].includes(token.role) && token.functionLevel === 'operations');
  if (!hasOperationsRole) {
    logSecurityEvent('callable_auth_denied', { reason: 'operations_required', actor: pseudonymousId(auth.uid) }, 'WARNING');
    throw new HttpsError('permission-denied', 'Operations role required.');
  }
  if (token.firebase?.sign_in_second_factor !== 'totp') {
    logSecurityEvent('callable_auth_denied', { reason: 'mfa_required', actor: pseudonymousId(auth.uid) }, 'WARNING');
    throw new HttpsError('failed-precondition', 'Two-factor authentication required.');
  }
  return requireActiveSession(auth, loadUser);
}

module.exports = { requireAuthenticatedUser, requireMfaAdmin, requireMfaOperations };
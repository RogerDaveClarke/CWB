const { getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logSecurityEvent, pseudonymousId } = require('./securityLog');

if (!getApps().length) initializeApp();

function identityMismatch(user, profile) {
  if (!profile) return 'missing-profile';
  const claims = user.customClaims || {};
  const profileSuspended = profile.status === 'suspended';
  if (Boolean(user.disabled) !== profileSuspended) return 'disabled-status-mismatch';
  if (profile.status === 'active' && (claims.role !== profile.role || claims.functionLevel !== profile.functionLevel)) {
    return 'role-claim-mismatch';
  }
  if (profile.status === 'active' && (claims.admin === true) !== (profile.role === 'admin')) {
    return 'admin-claim-mismatch';
  }
  return null;
}

async function listAllUsers(auth) {
  const users = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    users.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

exports.reconcileIdentityState = onSchedule({
  schedule: 'every 1 hours',
  timeZone: 'America/Los_Angeles',
  retryCount: 3,
  serviceAccount: 'cwb-user-admin@cwb-boat-operations-c50dd.iam.gserviceaccount.com'
}, async () => {
  const [users, profilesSnapshot] = await Promise.all([
    listAllUsers(getAuth()),
    getFirestore().collection('users').get()
  ]);
  const profiles = new Map();
  profilesSnapshot.forEach((document) => profiles.set(document.id, document.data()));

  const mismatches = [];
  for (const user of users) {
    const reason = identityMismatch(user, profiles.get(user.uid));
    if (reason) mismatches.push({ actor: pseudonymousId(user.uid), reason });
    profiles.delete(user.uid);
  }
  for (const uid of profiles.keys()) mismatches.push({ actor: pseudonymousId(uid), reason: 'missing-auth-user' });

  logSecurityEvent('identity_reconciliation', { checked: users.length, mismatchCount: mismatches.length });
  for (const mismatch of mismatches) logSecurityEvent('identity_state_mismatch', mismatch, 'ERROR');
});

module.exports.identityMismatch = identityMismatch;
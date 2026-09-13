const { getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');

if (!getApps().length) initializeApp();

const TRAIL_RETENTION_DAYS = 2;
const DELETE_BATCH_SIZE = 200;

function retentionCutoff(now = Date.now()) {
  return Timestamp.fromMillis(now - TRAIL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

async function deleteExpiredTrailBatch(db, cutoff) {
  const snapshot = await db.collectionGroup('history')
    .where('timestamp', '<', cutoff)
    .limit(DELETE_BATCH_SIZE)
    .get();
  if (snapshot.empty) return 0;

  const batch = db.batch();
  snapshot.docs.forEach((document) => batch.delete(document.ref));
  await batch.commit();
  return snapshot.size;
}

async function deleteExpiredInvitationBatch(db, now = Timestamp.now()) {
  const snapshot = await db.collection('user_invitations')
    .where('expiresAt', '<', now)
    .limit(DELETE_BATCH_SIZE)
    .get();
  if (snapshot.empty) return 0;

  const batch = db.batch();
  snapshot.docs.forEach((document) => batch.delete(document.ref));
  await batch.commit();
  return snapshot.size;
}

exports.purgeExpiredTrails = onSchedule({
  schedule: 'every 6 hours',
  timeZone: 'America/Los_Angeles',
  retryCount: 3,
  serviceAccount: 'cwb-telemetry-ingest@cwb-boat-operations-c50dd.iam.gserviceaccount.com'
}, async () => {
  const db = getFirestore();
  const cutoff = retentionCutoff();
  let deleted = 0;
  let batchSize;
  do {
    batchSize = await deleteExpiredTrailBatch(db, cutoff);
    deleted += batchSize;
  } while (batchSize === DELETE_BATCH_SIZE);

  console.log(JSON.stringify({ securityEvent: 'gps_retention_purge', deleted }));
});

exports.purgeExpiredInvitations = onSchedule({
  schedule: 'every 6 hours',
  timeZone: 'America/Los_Angeles',
  retryCount: 3,
  serviceAccount: 'cwb-user-admin@cwb-boat-operations-c50dd.iam.gserviceaccount.com'
}, async () => {
  const db = getFirestore();
  let deleted = 0;
  let batchSize;
  do {
    batchSize = await deleteExpiredInvitationBatch(db);
    deleted += batchSize;
  } while (batchSize === DELETE_BATCH_SIZE);
  console.log(JSON.stringify({ securityEvent: 'invitation_retention_purge', deleted }));
});

module.exports.retentionCutoff = retentionCutoff;
module.exports.deleteExpiredTrailBatch = deleteExpiredTrailBatch;
module.exports.deleteExpiredInvitationBatch = deleteExpiredInvitationBatch;
const { getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { createHash } = require('node:crypto');

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

async function deleteExpiredInvitationBatch(db, now = Timestamp.now(), auth = getAuth()) {
  const snapshot = await db.collection('user_invitations')
    .where('expiresAt', '<', now)
    .limit(DELETE_BATCH_SIZE)
    .get();
  if (snapshot.empty) return 0;

  let deleted = 0;
  for (const document of snapshot.docs) {
    const cleanup = await db.runTransaction(async transaction => {
      const invitation = await transaction.get(document.ref);
      if (!invitation.exists || invitation.get('expiresAt')?.toMillis?.() >= now.toMillis()) return null;
      transaction.update(invitation.ref, { status: 'cancelling' });
      return {
        invitationId: invitation.id,
        email: String(invitation.get('email') || '').trim().toLowerCase(),
        reservedUid: String(invitation.get('reservedUid') || '')
      };
    });
    if (!cleanup) continue;
    if (cleanup.reservedUid) {
      try {
        await auth.deleteUser(cleanup.reservedUid);
      } catch (error) {
        if (error.code !== 'auth/user-not-found') throw error;
      }
    }
    await db.runTransaction(async transaction => {
      const invitation = await transaction.get(document.ref);
      const profileRef = cleanup.reservedUid ? db.collection('users').doc(cleanup.reservedUid) : null;
      const reservationId = cleanup.email
        ? createHash('sha256').update(`email:${cleanup.email}`).digest('hex')
        : '';
      const reservationRef = reservationId
        ? db.collection('invitation_email_reservations').doc(reservationId)
        : null;
      const [profile, reservation] = await Promise.all([
        profileRef ? transaction.get(profileRef) : Promise.resolve(null),
        reservationRef ? transaction.get(reservationRef) : Promise.resolve(null)
      ]);
      if (profile?.exists && profile.get('status') === 'pending_mfa'
          && profile.get('invitationId') === cleanup.invitationId) transaction.delete(profileRef);
      if (invitation.exists && invitation.get('status') === 'cancelling') transaction.delete(invitation.ref);
      if (reservation?.exists && reservation.get('invitationId') === cleanup.invitationId) {
        transaction.delete(reservationRef);
      }
    });
    deleted += 1;
  }
  return deleted;
}

async function deleteOrphanInvitationReservationBatch(db, now = Timestamp.now()) {
  const snapshot = await db.collection('invitation_email_reservations')
    .where('expiresAt', '<', now)
    .limit(DELETE_BATCH_SIZE)
    .get();
  if (snapshot.empty) return 0;

  let deleted = 0;
  for (const document of snapshot.docs) {
    const removed = await db.runTransaction(async transaction => {
      const reservation = await transaction.get(document.ref);
      if (!reservation.exists || reservation.get('expiresAt')?.toMillis?.() >= now.toMillis()) return false;
      const invitationId = String(reservation.get('invitationId') || '');
      const invitationRef = db.collection('user_invitations').doc(invitationId || 'invalid');
      const invitation = await transaction.get(invitationRef);
      const invitationExpiresAt = invitation.get('expiresAt')?.toMillis?.() ?? 0;
      const invitationEmail = String(invitation.get('email') || '').trim().toLowerCase();
      const expectedReservationId = invitationEmail
        ? createHash('sha256').update(`email:${invitationEmail}`).digest('hex')
        : '';
      if (invitation.exists && invitationExpiresAt >= now.toMillis()
          && expectedReservationId === document.id) return false;
      transaction.delete(document.ref);
      return true;
    });
    if (removed) deleted += 1;
  }
  return deleted;
}

async function deleteExpiredBatteryEventBatch(db, now = Timestamp.now()) {
  const snapshot = await db.collection('battery_service_events')
    .where('expires_at', '<', now)
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
  let reservationsDeleted = 0;
  do {
    batchSize = await deleteOrphanInvitationReservationBatch(db);
    reservationsDeleted += batchSize;
  } while (batchSize === DELETE_BATCH_SIZE);
  console.log(JSON.stringify({ securityEvent: 'invitation_retention_purge', deleted, reservationsDeleted }));
});

exports.purgeExpiredBatteryEvents = onSchedule({
  schedule: 'every 24 hours',
  timeZone: 'America/Los_Angeles',
  retryCount: 3,
  serviceAccount: 'cwb-user-admin@cwb-boat-operations-c50dd.iam.gserviceaccount.com'
}, async () => {
  const db = getFirestore();
  let deleted = 0;
  let batchSize;
  do {
    batchSize = await deleteExpiredBatteryEventBatch(db);
    deleted += batchSize;
  } while (batchSize === DELETE_BATCH_SIZE);
  console.log(JSON.stringify({ securityEvent: 'battery_event_retention_purge', deleted }));
});

module.exports.retentionCutoff = retentionCutoff;
module.exports.deleteExpiredTrailBatch = deleteExpiredTrailBatch;
module.exports.deleteExpiredInvitationBatch = deleteExpiredInvitationBatch;
module.exports.deleteOrphanInvitationReservationBatch = deleteOrphanInvitationReservationBatch;
module.exports.deleteExpiredBatteryEventBatch = deleteExpiredBatteryEventBatch;
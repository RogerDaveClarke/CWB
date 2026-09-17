const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { deleteExpiredBatteryEventBatch, deleteExpiredInvitationBatch, retentionCutoff } = require('../retention');

test('GPS trail retention cutoff is exactly two days', () => {
  const now = Date.UTC(2026, 8, 10, 12, 0, 0);
  assert.equal(retentionCutoff(now).toMillis(), now - 2 * 24 * 60 * 60 * 1000);
});

test('battery event retention deletes the expired query batch', async () => {
  const deleted = [];
  const documents = [{ ref: { path: 'battery_service_events/event-1' } }, { ref: { path: 'battery_service_events/event-2' } }];
  const query = {
    where(field, operator) { assert.equal(field, 'expires_at'); assert.equal(operator, '<'); return this; },
    limit(value) { assert.equal(value, 200); return this; },
    async get() { return { empty: false, size: documents.length, docs: documents }; }
  };
  const db = {
    collection(name) { assert.equal(name, 'battery_service_events'); return query; },
    batch() { return { delete(ref) { deleted.push(ref.path); }, async commit() {} }; }
  };

  assert.equal(await deleteExpiredBatteryEventBatch(db), 2);
  assert.deepEqual(deleted, ['battery_service_events/event-1', 'battery_service_events/event-2']);
});

test('invitation retention deletes only the reservation for the same invitation generation', async () => {
  const now = { toMillis: () => 2000 };
  const expiredAt = { toMillis: () => 1000 };
  const reservationPath = email => `invitation_email_reservations/${createHash('sha256').update(`email:${email}`).digest('hex')}`;
  const references = {
    first: { id: 'invite-1', path: 'user_invitations/invite-1' },
    second: { id: 'invite-2', path: 'user_invitations/invite-2' },
    firstProfile: { path: 'users/user-1' },
    firstReservation: { path: reservationPath('first@example.org') },
    secondReservation: { path: reservationPath('second@example.org') }
  };
  const dataByPath = new Map([
    [references.first.path, { email: 'first@example.org', expiresAt: expiredAt, reservedUid: 'user-1', status: 'reserved' }],
    [references.second.path, { email: 'second@example.org', expiresAt: expiredAt }],
    [references.firstProfile.path, { status: 'pending_mfa', invitationId: 'invite-1' }],
    [references.firstReservation.path, { invitationId: 'invite-1' }],
    [references.secondReservation.path, { invitationId: 'newer-invite' }]
  ]);
  const snapshotFor = reference => ({
    exists: dataByPath.has(reference.path), reference, ref: reference, id: reference.id,
    get(field) { return dataByPath.get(reference.path)?.[field]; }
  });
  const deleted = [];
  const invitationQuery = {
    where(field, operator, value) {
      assert.equal(field, 'expiresAt'); assert.equal(operator, '<'); assert.equal(value, now); return this;
    },
    limit(value) { assert.equal(value, 200); return this; },
    async get() { return { empty: false, docs: [snapshotFor(references.first), snapshotFor(references.second)] }; }
  };
  const db = {
    collection(name) {
      if (name === 'user_invitations') return invitationQuery;
      assert.ok(['invitation_email_reservations', 'users'].includes(name));
      return { doc(id) { return { path: `${name}/${id}` }; } };
    },
    async runTransaction(handler) {
      return handler({
        async get(reference) { return snapshotFor(reference); },
        update(reference, values) { Object.assign(dataByPath.get(reference.path), values); },
        delete(reference) { deleted.push(reference.path); }
      });
    }
  };
  const deletedUsers = [];
  const auth = { async deleteUser(uid) { deletedUsers.push(uid); } };

  assert.equal(await deleteExpiredInvitationBatch(db, now, auth), 2);
  assert.deepEqual(deletedUsers, ['user-1']);
  assert.deepEqual(deleted.sort(), [
    references.firstReservation.path,
    references.firstProfile.path,
    references.first.path,
    references.second.path
  ].sort());
});
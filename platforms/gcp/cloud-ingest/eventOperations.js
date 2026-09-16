const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { requireMfaOperations } = require('./authGuards');
const { checkoutBatteryDecision } = require('./batteryPolicy');
const { pseudonymousId } = require('./securityLog');

if (!getApps().length) initializeApp();
const db = getFirestore();

const CALLABLE_OPTIONS = {
  enforceAppCheck: true,
  serviceAccount: 'cwb-user-admin@cwb-boat-operations-c50dd.iam.gserviceaccount.com'
};
const EVENT_STATUSES = new Set(['planned', 'active', 'completed', 'cancelled']);
const PARTICIPATION_TYPES = new Set(['Public renter', 'Event participant', 'CWB volunteer', 'CWB staff', 'Charter guest']);
const BATTERY_EVENT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

function requiredText(value, field, maxLength = 80) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maxLength) {
    throw new HttpsError('invalid-argument', `${field} is required and must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function validDocumentId(value, field) {
  const normalized = requiredText(value, field, 128);
  if (normalized.includes('/')) throw new HttpsError('invalid-argument', `${field} is invalid.`);
  return normalized;
}

function validateEventInput(data = {}) {
  const name = requiredText(data.name, 'Event name');
  const eventTypeId = validDocumentId(data.eventTypeId, 'Event type');
  const startsAt = new Date(data.startsAt);
  if (Number.isNaN(startsAt.getTime())) throw new HttpsError('invalid-argument', 'A valid event start date is required.');
  const defaultDurationMinutes = Number(data.defaultDurationMinutes);
  if (!Number.isInteger(defaultDurationMinutes) || defaultDurationMinutes < 15 || defaultDurationMinutes > 480) {
    throw new HttpsError('invalid-argument', 'Default trip duration must be between 15 and 480 minutes.');
  }
  const boatIds = [...new Set(Array.isArray(data.boatIds) ? data.boatIds : [])];
  if (!boatIds.length || boatIds.length > 50 || boatIds.some(id => !/^[0-9a-f]{16}$/i.test(id))) {
    throw new HttpsError('invalid-argument', 'Assign between 1 and 50 valid boats.');
  }
  return { name, eventTypeId, startsAt, defaultDurationMinutes, boatIds };
}

function validateDepartureInput(data = {}) {
  const eventId = validDocumentId(data.eventId, 'Event');
  const boatId = requiredText(data.boatId, 'Boat ID', 16);
  if (!/^[0-9a-f]{16}$/i.test(boatId)) throw new HttpsError('invalid-argument', 'A valid boat ID is required.');
  const responsibleName = requiredText(data.responsibleName, 'Responsible person', 60);
  const participationType = requiredText(data.participationType, 'Participation type', 40);
  if (!PARTICIPATION_TYPES.has(participationType)) throw new HttpsError('invalid-argument', 'Unknown participation type.');
  const passengerCount = Number(data.passengerCount);
  if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 12) {
    throw new HttpsError('invalid-argument', 'People aboard must be between 1 and 12.');
  }
  const durationMinutes = Number(data.durationMinutes);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480) {
    throw new HttpsError('invalid-argument', 'Trip duration must be between 15 and 480 minutes.');
  }
  return { eventId, boatId, responsibleName, participationType, passengerCount, durationMinutes, overrideReason: data.overrideReason };
}

function batteryFailure(reason) {
  const messages = {
    'battery-charging': 'The battery is being charged.',
    'battery-verification': 'Wait for three green device readings after installing the battery.',
    'battery-service-unverified': 'The battery service state must be verified before checkout.',
    'battery-unverified': 'A current battery reading is required before checkout.',
    'battery-reading-stale': 'The battery reading is stale. Wait for a new tracker report.',
    'battery-critical': 'The battery is critically low and cannot be overridden.',
    'management-override-required': 'A manager or administrator must authorize this red-battery trip.',
    'override-reason-required': 'Enter an override reason between 10 and 500 characters.'
  };
  return new HttpsError('failed-precondition', messages[reason] || 'The battery is not ready for checkout.');
}

exports.createEvent = onCall(CALLABLE_OPTIONS, async (request) => {
  await requireMfaOperations(request);
  const input = validateEventInput(request.data);
  const typeRef = db.collection('event_types').doc(input.eventTypeId);
  const boatRefs = input.boatIds.map(id => db.collection('boats').doc(id));
  const [typeSnapshot, ...boatSnapshots] = await db.getAll(typeRef, ...boatRefs);
  if (!typeSnapshot.exists || typeSnapshot.get('active') !== true) {
    throw new HttpsError('failed-precondition', 'Select an active event type.');
  }
  if (boatSnapshots.some(snapshot => !snapshot.exists)) throw new HttpsError('not-found', 'One or more assigned boats do not exist.');
  if (boatSnapshots.some(snapshot => snapshot.get('availability_status') === 'under_repair')) {
    throw new HttpsError('failed-precondition', 'A boat under repair cannot be assigned to an event.');
  }

  const eventRef = db.collection('events').doc();
  const batch = db.batch();
  batch.create(eventRef, {
    name: input.name,
    event_type_id: input.eventTypeId,
    event_type_name: typeSnapshot.get('name'),
    starts_at: Timestamp.fromDate(input.startsAt),
    default_duration_minutes: input.defaultDurationMinutes,
    status: 'planned',
    boat_ids: input.boatIds,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp()
  });
  boatSnapshots.forEach((snapshot, index) => batch.create(eventRef.collection('boat_sessions').doc(input.boatIds[index]), {
    boat_id: input.boatIds[index],
    vessel_name: snapshot.get('vessel_name') || input.boatIds[index],
    boat_type: snapshot.get('boat_type') || '',
    status: 'at_dock',
    updated_at: FieldValue.serverTimestamp()
  }));
  await batch.commit();
  return { eventId: eventRef.id };
});

exports.setEventStatus = onCall(CALLABLE_OPTIONS, async (request) => {
  await requireMfaOperations(request);
  const eventId = validDocumentId(request.data?.eventId, 'Event');
  const status = requiredText(request.data?.status, 'Status', 20);
  if (!EVENT_STATUSES.has(status) || !['active', 'completed', 'cancelled'].includes(status)) {
    throw new HttpsError('invalid-argument', 'Unknown event status.');
  }
  const eventRef = db.collection('events').doc(eventId);
  const sessionsQuery = eventRef.collection('boat_sessions').where('status', 'in', ['out', 'overdue']);
  await db.runTransaction(async transaction => {
    const [eventSnapshot, activeSessions] = await Promise.all([transaction.get(eventRef), transaction.get(sessionsQuery)]);
    if (!eventSnapshot.exists) throw new HttpsError('not-found', 'Event not found.');
    const currentStatus = eventSnapshot.get('status');
    if (status === 'active' && currentStatus !== 'planned') throw new HttpsError('failed-precondition', 'Only planned events can be started.');
    if (['completed', 'cancelled'].includes(status) && !activeSessions.empty) {
      throw new HttpsError('failed-precondition', 'Every boat must be returned before closing the event.');
    }
    transaction.update(eventRef, { status, updated_at: FieldValue.serverTimestamp() });
  });
  return { eventId, status };
});

exports.checkOutEventBoat = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = await requireMfaOperations(request);
  const input = validateDepartureInput(request.data);
  const eventRef = db.collection('events').doc(input.eventId);
  const boatRef = db.collection('boats').doc(input.boatId);
  const sessionRef = eventRef.collection('boat_sessions').doc(input.boatId);
  const activityRef = eventRef.collection('activity').doc();
  const overrideEventRef = db.collection('battery_service_events').doc();
  const departedAt = new Date();
  const dueAt = new Date(departedAt.getTime() + input.durationMinutes * 60000);

  await db.runTransaction(async transaction => {
    const [eventSnapshot, boatSnapshot, sessionSnapshot] = await Promise.all([
      transaction.get(eventRef), transaction.get(boatRef), transaction.get(sessionRef)
    ]);
    if (!eventSnapshot.exists || eventSnapshot.get('status') !== 'active') throw new HttpsError('failed-precondition', 'The event is not active.');
    if (!sessionSnapshot.exists) throw new HttpsError('failed-precondition', 'This boat is not assigned to the event.');
    if (!boatSnapshot.exists) throw new HttpsError('not-found', 'Boat not found.');
    const boat = boatSnapshot.data();
    if (boat.tracking_enabled === true || boat.availability_status !== 'available') {
      throw new HttpsError('failed-precondition', 'The boat is not available at the dock.');
    }
    const millivolts = Number(boat.last_ping?.battery_mv || 0);
    const decision = checkoutBatteryDecision({
      millivolts,
      readingTimestamp: boat.last_ping?.timestamp,
      serviceStatus: boat.battery_service_status,
      role: auth.token?.role,
      isAdmin: auth.token?.admin === true,
      overrideReason: input.overrideReason
    });
    if (!decision.allowed) throw batteryFailure(decision.reason);
    transaction.update(boatRef, {
      availability_status: 'rented', tracking_enabled: true, booked: true,
      booked_by: input.responsibleName, renter_type: input.participationType,
      passenger_count: input.passengerCount, rental_type: 'fixed', rental_minutes: input.durationMinutes,
      time_out: Timestamp.fromDate(departedAt), time_due_back: Timestamp.fromDate(dueAt),
      use_type: 'event', event_id: input.eventId, event_name: eventSnapshot.get('name'),
      actual_time_back: FieldValue.delete(), battery_override_active: decision.override === true,
      rental_updated_at: FieldValue.serverTimestamp()
    });
    transaction.set(sessionRef, {
      status: 'out', passenger_count: input.passengerCount,
      departed_at: Timestamp.fromDate(departedAt), due_at: Timestamp.fromDate(dueAt),
      returned_at: FieldValue.delete(), updated_at: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.create(activityRef, {
      action: 'departure', boat_id: input.boatId, vessel_name: boat.vessel_name || input.boatId,
      passenger_count: input.passengerCount, occurred_at: FieldValue.serverTimestamp()
    });
    if (decision.override) {
      transaction.create(overrideEventRef, {
        device_id: input.boatId, battery_id: boat.battery_id || input.boatId,
        event_type: 'rental_override', voltage_mv: millivolts,
        battery_health: decision.health, reason: decision.overrideReason,
        actor_id: pseudonymousId(auth.uid), recorded_at: FieldValue.serverTimestamp(),
        expires_at: new Date(Date.now() + BATTERY_EVENT_RETENTION_MS)
      });
    }
  });
  return { eventId: input.eventId, boatId: input.boatId };
});

module.exports.validateEventInput = validateEventInput;
module.exports.validateDepartureInput = validateDepartureInput;
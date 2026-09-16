const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
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
const RENTER_TYPES = new Set(['Public', 'Volunteer', 'Dire Hard', 'Libary Pass']);
const BATTERY_EVENT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

function requiredBoatId(value) {
  const boatId = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{16}$/.test(boatId)) throw new HttpsError('invalid-argument', 'A valid boat ID is required.');
  return boatId;
}

function checkoutInput(data = {}) {
  const boatId = requiredBoatId(data.boatId);
  const renterName = typeof data.renterName === 'string' ? data.renterName.trim() : '';
  const renterType = typeof data.renterType === 'string' ? data.renterType.trim() : '';
  const passengerCount = Number(data.passengerCount);
  if (!renterName || renterName.length > 60) throw new HttpsError('invalid-argument', 'Renter name is required and must be 60 characters or fewer.');
  if (!RENTER_TYPES.has(renterType)) throw new HttpsError('invalid-argument', 'Select a valid renter type.');
  if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 6) {
    throw new HttpsError('invalid-argument', 'Passengers must be between 1 and 6.');
  }
  return { boatId, renterName, renterType, passengerCount, overrideReason: data.overrideReason };
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

exports.checkOutBoat = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = await requireMfaOperations(request);
  const input = checkoutInput(request.data);
  const boatRef = db.collection('boats').doc(input.boatId);
  const overrideEventRef = db.collection('battery_service_events').doc();

  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(boatRef);
    if (!snapshot.exists) throw new HttpsError('not-found', 'Boat not found.');
    const boat = snapshot.data();
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
      availability_status: 'rented',
      tracking_enabled: true,
      booked: true,
      booked_by: input.renterName,
      renter_type: input.renterType,
      passenger_count: input.passengerCount,
      rental_type: 'fixed',
      rental_minutes: 60,
      time_out: FieldValue.serverTimestamp(),
      actual_time_back: FieldValue.delete(),
      battery_override_active: decision.override === true,
      rental_updated_at: FieldValue.serverTimestamp()
    });
    if (decision.override) {
      transaction.create(overrideEventRef, {
        device_id: input.boatId,
        battery_id: boat.battery_id || input.boatId,
        event_type: 'rental_override',
        voltage_mv: millivolts,
        battery_health: decision.health,
        reason: decision.overrideReason,
        actor_id: pseudonymousId(auth.uid),
        recorded_at: FieldValue.serverTimestamp(),
        expires_at: new Date(Date.now() + BATTERY_EVENT_RETENTION_MS)
      });
    }
  });
  return { boatId: input.boatId, checkedOut: true };
});

exports.startBatteryCharging = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = await requireMfaOperations(request);
  const boatId = requiredBoatId(request.data?.boatId);
  const boatRef = db.collection('boats').doc(boatId);
  const eventRef = db.collection('battery_service_events').doc();
  const cycleRef = db.collection('battery_cycles').doc();

  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(boatRef);
    if (!snapshot.exists) throw new HttpsError('not-found', 'Boat not found.');
    const boat = snapshot.data();
    if (boat.tracking_enabled === true || boat.availability_status === 'rented') {
      throw new HttpsError('failed-precondition', 'Check in the boat before removing its battery.');
    }
    if (boat.battery_service_status === 'charging') return;

    if (boat.battery_cycle_started_at) {
      transaction.create(cycleRef, {
        device_id: boatId,
        battery_id: boat.battery_id || boatId,
        started_at: boat.battery_cycle_started_at,
        ended_at: FieldValue.serverTimestamp(),
        starting_voltage_mv: Number(boat.battery_cycle_start_mv || 0),
        ending_voltage_mv: Number(boat.last_ping?.battery_mv || 0),
        minimum_voltage_mv: Number(boat.battery_cycle_min_mv || boat.last_ping?.battery_mv || 0),
        trip_count: Number(boat.battery_cycle_trip_count || 0),
        operating_minutes: Number(boat.battery_cycle_operating_minutes || 0)
      });
    }
    transaction.update(boatRef, {
      battery_service_status: 'charging',
      battery_charge_started_at: FieldValue.serverTimestamp(),
      battery_verification_count: FieldValue.delete(),
      battery_cycle_started_at: FieldValue.delete(),
      battery_cycle_start_mv: FieldValue.delete(),
      battery_cycle_min_mv: FieldValue.delete(),
      battery_cycle_trip_count: FieldValue.delete(),
      battery_cycle_operating_minutes: FieldValue.delete()
    });
    transaction.create(eventRef, {
      device_id: boatId,
      battery_id: boat.battery_id || boatId,
      event_type: 'charge_started',
      voltage_mv: Number(boat.last_ping?.battery_mv || 0),
      actor_id: pseudonymousId(auth.uid),
      recorded_at: FieldValue.serverTimestamp(),
      expires_at: new Date(Date.now() + BATTERY_EVENT_RETENTION_MS)
    });
  });
  return { boatId, batteryServiceStatus: 'charging' };
});

exports.markBatteryInstalled = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = await requireMfaOperations(request);
  const boatId = requiredBoatId(request.data?.boatId);
  const boatRef = db.collection('boats').doc(boatId);
  const eventRef = db.collection('battery_service_events').doc();

  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(boatRef);
    if (!snapshot.exists) throw new HttpsError('not-found', 'Boat not found.');
    const boat = snapshot.data();
    if (boat.tracking_enabled === true || boat.availability_status === 'rented') {
      throw new HttpsError('failed-precondition', 'Check in the boat before installing its battery.');
    }
    if (boat.battery_service_status !== 'charging') {
      throw new HttpsError('failed-precondition', 'Mark the battery as charging before reinstalling it.');
    }
    const frameCounter = Number(boat.last_ping?.frame_counter);
    if (!Number.isSafeInteger(frameCounter) || frameCounter < 0) {
      throw new HttpsError('failed-precondition', 'Wait for a current tracker report before installing the battery.');
    }
    transaction.update(boatRef, {
      battery_service_status: 'verification',
      battery_installed_at: FieldValue.serverTimestamp(),
      battery_verification_count: 0,
      battery_verification_after_fcnt: frameCounter,
      battery_verification_last_fcnt: frameCounter
    });
    transaction.create(eventRef, {
      device_id: boatId,
      battery_id: boat.battery_id || boatId,
      event_type: 'battery_installed',
      actor_id: pseudonymousId(auth.uid),
      recorded_at: FieldValue.serverTimestamp(),
      expires_at: new Date(Date.now() + BATTERY_EVENT_RETENTION_MS)
    });
  });
  return { boatId, batteryServiceStatus: 'verification' };
});

module.exports.requiredBoatId = requiredBoatId;
module.exports.checkoutInput = checkoutInput;
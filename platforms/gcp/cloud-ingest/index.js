const { initializeApp } = require('firebase-admin/app');
const { createHash } = require('node:crypto');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onRequest } = require('firebase-functions/v2/https');
const { authenticateWebhookRequest } = require('./webhookAuth');
const { logSecurityEvent } = require('./securityLog');
const { batteryHealth, batteryVerificationProgress } = require('./batteryPolicy');

setGlobalOptions({ region: 'us-west1' });

initializeApp();
const db = getFirestore();
const SUPPORTED_PROTOCOL_VERSION = 1;
const V1_PAYLOAD_LENGTH = 16;

exports.telemetryIngest = onRequest({
  secrets: ['CHIRPSTACK_WEBHOOK_TOKEN'],
  serviceAccount: 'cwb-telemetry-ingest@cwb-boat-operations-c50dd.iam.gserviceaccount.com',
  timeoutSeconds: 30,
  maxInstances: 10
}, async (req, res) => {
  try {
    const expectedToken = process.env.CHIRPSTACK_WEBHOOK_TOKEN;
    const authentication = authenticateWebhookRequest(req, expectedToken);
    if (!authentication.ok) {
      logSecurityEvent('webhook_rejected', { status: authentication.status }, 'WARNING');
      for (const [name, value] of Object.entries(authentication.headers)) {
        res.set(name, value);
      }
      return res.status(authentication.status).send(authentication.message);
    }
    if (req.query.event && req.query.event !== 'up') {
      return res.status(204).send();
    }

    const integrationData = req.body;
    if (!integrationData || typeof integrationData !== 'object' || Array.isArray(integrationData)) {
      return res.status(400).send('Missing uplink event body.');
    }

    const boatId = integrationData.deviceInfo?.devEui
      || integrationData.dev_eui
      || integrationData.device_id;
    const base64Payload = integrationData.data || integrationData.payload_raw;
    const frameCounter = Number(integrationData.fCnt ?? integrationData.f_cnt);
    if (typeof boatId !== 'string' || typeof base64Payload !== 'string') {
      return res.status(400).send('Missing device identity or base64 uplink data.');
    }
    if (!Number.isSafeInteger(frameCounter) || frameCounter < 0) {
      return res.status(400).send('Missing or invalid uplink frame counter.');
    }
    if (!/^[0-9a-f]{16}$/i.test(boatId)) {
      return res.status(400).send('Invalid device identity.');
    }

    const buffer = Buffer.from(base64Payload, 'base64');

    if (buffer.length < 1) {
      return res.status(400).send('Malformed packet layout size.');
    }

    const protocolVersion = buffer.readUInt8(0);
    if (protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
      return res.status(400).send('Unsupported telemetry protocol version.');
    }
    if (buffer.length !== V1_PAYLOAD_LENGTH) {
      return res.status(400).send('Malformed version 1 packet layout size.');
    }

    const lat = buffer.readInt32LE(1) / 10000000;
    const lon = buffer.readInt32LE(5) / 10000000;
    const battMv = buffer.readUInt16LE(9);
    const varianceRaw = buffer.readUInt16LE(11);
    const maxTempCentiC = buffer.readInt16LE(13);
    const flags = buffer.readUInt8(15);

    const lowBatteryAlert = (flags & 0x01) === 0x01;
    const gpsFixFound = (flags & 0x02) === 0x02;
    const isTiedUp = (flags & 0x04) === 0x04;
    const thermalValid = (flags & 0x08) === 0x08;
    const mooringClassificationValid = (flags & 0x10) === 0x10;
    const batteryHealthState = batteryHealth(battMv);
    const calculatedVariance = varianceRaw / 100000;
    const mooringStatus = !gpsFixFound
      ? "Unknown"
      : !mooringClassificationValid
        ? "Outside Dock Geofence"
        : isTiedUp
          ? "Tied Up at Dock"
          : "Underway at Dock";

    const pingPayload = {
      protocol_version: protocolVersion,
      frame_counter: frameCounter,
      latitude: lat,
      longitude: lon,
      battery_mv: battMv,
      battery_health: batteryHealthState,
      low_battery: lowBatteryAlert,
      gps_fix: gpsFixFound,
      inside_dock_geofence: mooringClassificationValid,
      mooring_classification_valid: mooringClassificationValid,
      mooring_status: mooringStatus,
      variance_g2: mooringClassificationValid ? calculatedVariance : null,
      max_temperature_c: thermalValid ? maxTempCentiC / 100 : null,
      timestamp: FieldValue.serverTimestamp()
    };

    const eventIdentity = integrationData.deduplicationId
      || integrationData.deduplication_id
      || req.rawBody
      || JSON.stringify(integrationData);
    const eventId = createHash('sha256')
      .update(boatId.toLowerCase())
      .update('\0')
      .update(String(req.query.event || 'up'))
      .update('\0')
      .update(eventIdentity)
      .digest('hex');
    const trackingRef = db.collection('boats').doc(boatId);
    const receiptRef = db.collection('_ingest_receipts').doc(eventId);
    const verificationEventRef = db.collection('battery_service_events').doc(`charge-verified-${eventId}`);

    const result = await db.runTransaction(async (transaction) => {
      const [receiptSnapshot, boatSnapshot] = await Promise.all([
        transaction.get(receiptRef),
        transaction.get(trackingRef)
      ]);
      if (receiptSnapshot.exists) return 'duplicate';
      if (!boatSnapshot.exists) return 'unknown-device';

      const trackingEnabled = boatSnapshot.get('tracking_enabled') === true;
      const { latitude, longitude, ...operationalPingPayload } = pingPayload;
      const boat = boatSnapshot.data();
      const trackingUpdate = {
        last_ping: trackingEnabled ? pingPayload : operationalPingPayload,
        device_id: boatId
      };
      if (boat.battery_service_status == null) trackingUpdate.battery_service_status = 'ready';
      if (boat.battery_cycle_started_at) {
        const previousMinimum = Number(boat.battery_cycle_min_mv || battMv);
        trackingUpdate.battery_cycle_min_mv = Math.min(previousMinimum, battMv);
      }
      if (boat.battery_service_status === 'verification') {
        const verification = batteryVerificationProgress({
          health: batteryHealthState,
          frameCounter,
          afterFrameCounter: Number(boat.battery_verification_after_fcnt),
          lastFrameCounter: Number(boat.battery_verification_last_fcnt),
          count: Number(boat.battery_verification_count || 0)
        });
        if (verification.accepted) {
          trackingUpdate.battery_verification_count = verification.count;
          trackingUpdate.battery_verification_last_fcnt = frameCounter;
        }
        if (verification.complete) {
          trackingUpdate.battery_service_status = 'ready';
          trackingUpdate.battery_verification_count = FieldValue.delete();
          trackingUpdate.battery_verification_after_fcnt = FieldValue.delete();
          trackingUpdate.battery_verification_last_fcnt = FieldValue.delete();
          trackingUpdate.battery_last_charged_at = FieldValue.serverTimestamp();
          trackingUpdate.battery_cycle_started_at = FieldValue.serverTimestamp();
          trackingUpdate.battery_cycle_start_mv = battMv;
          trackingUpdate.battery_cycle_min_mv = battMv;
          trackingUpdate.battery_cycle_trip_count = 0;
          trackingUpdate.battery_cycle_operating_minutes = 0;
          transaction.create(verificationEventRef, {
            device_id: boatId,
            battery_id: boat.battery_id || boatId,
            event_type: 'charge_verified',
            voltage_mv: battMv,
            battery_health: batteryHealthState,
            recorded_at: FieldValue.serverTimestamp(),
            expires_at: Timestamp.fromMillis(Date.now() + 365 * 24 * 60 * 60 * 1000)
          });
        }
      }
      transaction.update(trackingRef, trackingUpdate);

      // A deterministic document ID makes an authenticated retry idempotent.
      if (trackingEnabled) {
        transaction.set(trackingRef.collection('history').doc(eventId), pingPayload);
      }
      transaction.create(receiptRef, {
        received_at: FieldValue.serverTimestamp(),
        expires_at: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000)
      });
      return 'accepted';
    });

    if (result === 'unknown-device') {
      logSecurityEvent('webhook_unknown_device', {}, 'WARNING');
      return res.status(404).send('Unknown device.');
    }
    if (result === 'duplicate') {
      return res.status(200).send('Duplicate telemetry event ignored.');
    }

    return res.status(200).send('Telemetry parsed and updated successfully.');
  } catch (error) {
    console.error('Ingest Engine Fault Error:', error);
    return res.status(500).send('Internal Data Stream Interrupted.');
  }
});

// Account administration callable functions (inviteUser, setUserRole, etc.).
// Exported alongside the telemetry ingest HTTP function.
const userAdmin = require('./userAdmin');
exports.inviteUser = userAdmin.inviteUser;
exports.cancelUserInvitation = userAdmin.cancelUserInvitation;
exports.acceptUserInvitation = userAdmin.acceptUserInvitation;
exports.completeUserInvitation = userAdmin.completeUserInvitation;
exports.updateUserProfile = userAdmin.updateUserProfile;
exports.setUserRole = userAdmin.setUserRole;
exports.disableUser = userAdmin.disableUser;
exports.enableUser = userAdmin.enableUser;
exports.deleteUser = userAdmin.deleteUser;
exports.resetUserMfa = userAdmin.resetUserMfa;
exports.listUsers = userAdmin.listUsers;
exports.reportSessionExit = userAdmin.reportSessionExit;
exports.recordUserLogin = userAdmin.recordUserLogin;
exports.recordMfaEnrollment = userAdmin.recordMfaEnrollment;
exports.retryLifecycleNotifications = userAdmin.retryLifecycleNotifications;
exports.checkInBoat = userAdmin.checkInBoat;

const batteryOperations = require('./batteryOperations');
exports.checkOutBoat = batteryOperations.checkOutBoat;
exports.startBatteryCharging = batteryOperations.startBatteryCharging;
exports.markBatteryInstalled = batteryOperations.markBatteryInstalled;

const eventOperations = require('./eventOperations');
exports.createEvent = eventOperations.createEvent;
exports.setEventStatus = eventOperations.setEventStatus;
exports.checkOutEventBoat = eventOperations.checkOutEventBoat;

// Boat tracker configuration downlinks via the ChirpStack LoRaWAN gateway.
const boatConfig = require('./boatConfig');
exports.pushBoatConfig = boatConfig.pushBoatConfig;

const retention = require('./retention');
exports.purgeExpiredTrails = retention.purgeExpiredTrails;
exports.purgeExpiredInvitations = retention.purgeExpiredInvitations;
exports.purgeExpiredBatteryEvents = retention.purgeExpiredBatteryEvents;

const identityReconciliation = require('./identityReconciliation');
exports.reconcileIdentityState = identityReconciliation.reconcileIdentityState;
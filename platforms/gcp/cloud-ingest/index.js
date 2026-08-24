const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();
const SUPPORTED_PROTOCOL_VERSION = 1;
const V1_PAYLOAD_LENGTH = 16;

exports.telemetryIngest = async (req, res) => {
  try {
    const expectedToken = process.env.CHIRPSTACK_WEBHOOK_TOKEN;
    if (!expectedToken) {
      console.error('CHIRPSTACK_WEBHOOK_TOKEN is not configured.');
      return res.status(500).send('Webhook authentication is not configured.');
    }
    if (req.get('x-cwb-webhook-token') !== expectedToken) {
      return res.status(403).send('Forbidden.');
    }
    if (req.query.event && req.query.event !== 'up') {
      return res.status(204).send();
    }

    const integrationData = req.body;
    if (!integrationData) {
      return res.status(400).send('Missing uplink event body.');
    }

    const boatId = integrationData.deviceInfo?.devEui
      || integrationData.dev_eui
      || integrationData.device_id;
    const base64Payload = integrationData.data || integrationData.payload_raw;
    if (!boatId || !base64Payload) {
      return res.status(400).send('Missing device identity or base64 uplink data.');
    }

    const buffer = Buffer.from(base64Payload, 'base64');

    if (buffer.length < 1) {
      return res.status(400).send('Malformed packet layout size.');
    }

    const protocolVersion = buffer.readUInt8(0);
    if (protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
      return res.status(400).send(`Unsupported telemetry protocol version: ${protocolVersion}.`);
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
      latitude: lat,
      longitude: lon,
      battery_mv: battMv,
      low_battery: lowBatteryAlert,
      gps_fix: gpsFixFound,
      inside_dock_geofence: mooringClassificationValid,
      mooring_classification_valid: mooringClassificationValid,
      mooring_status: mooringStatus,
      variance_g2: mooringClassificationValid ? calculatedVariance : null,
      max_temperature_c: thermalValid ? maxTempCentiC / 100 : null,
      timestamp: FieldValue.serverTimestamp()
    };

    const trackingRef = db.collection('boats').doc(boatId);
    await trackingRef.set({
      last_ping: pingPayload,
      device_id: boatId
    }, { merge: true });

    // GPS breadcrumbs are only retained while a boat is checked out to a renter.
    const boatSnapshot = await trackingRef.get();
    if (boatSnapshot.get('tracking_enabled') === true) {
      await trackingRef.collection('history').add(pingPayload);
    }

    return res.status(200).send('Telemetry parsed and updated successfully.');
  } catch (error) {
    console.error('Ingest Engine Fault Error:', error);
    return res.status(500).send('Internal Data Stream Interrupted.');
  }
};
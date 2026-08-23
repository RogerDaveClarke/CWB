const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

exports.telemetryIngest = async (req, res) => {
  try {
    const integrationData = req.body;
    if (!integrationData || !integrationData.payload_raw) {
      return res.status(400).send('Missing payload_raw properties.');
    }

    const boatId = integrationData.dev_eui || integrationData.device_id || "unknown_vessel";
    const base64Payload = integrationData.payload_raw; 
    const buffer = Buffer.from(base64Payload, 'base64');

    if (buffer.length < 15) {
      return res.status(400).send('Malformed packet layout size.');
    }

    // Unpack multi-byte binary structures
    const lat = buffer.readInt32LE(0) / 10000000;
    const lon = buffer.readInt32LE(4) / 10000000;
    const battMv = buffer.readUInt16LE(8);
    const varianceRaw = buffer.readUInt16LE(10);
    const maxTempCentiC = buffer.readInt16LE(12);
    const flags = buffer.readUInt8(14);

    const lowBatteryAlert = (flags & 0x01) === 0x01;
    const gpsFixFound = (flags & 0x02) === 0x02;
    const isTiedUp = (flags & 0x04) === 0x04;
    const thermalValid = (flags & 0x08) === 0x08;
    const calculatedVariance = varianceRaw / 100000;

    const pingPayload = {
      latitude: lat,
      longitude: lon,
      battery_mv: battMv,
      low_battery: lowBatteryAlert,
      gps_fix: gpsFixFound,
      mooring_status: isTiedUp ? "Tied Up at Dock" : "Underway / Moving",
      variance_g2: calculatedVariance,
      max_temperature_c: thermalValid ? maxTempCentiC / 100 : null,
      timestamp: FieldValue.serverTimestamp()
    };

    const trackingRef = db.collection('boats').doc(boatId);
    await trackingRef.set({
      last_ping: pingPayload,
      device_id: boatId
    }, { merge: true });

    await trackingRef.collection('history').add(pingPayload);

    return res.status(200).send('Telemetry parsed and updated successfully.');
  } catch (error) {
    console.error('Ingest Engine Fault Error:', error);
    return res.status(500).send('Internal Data Stream Interrupted.');
  }
};
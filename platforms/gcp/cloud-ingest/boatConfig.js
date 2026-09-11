// Callable Cloud Function that pushes a boat's configuration to its tracker
// device through the ChirpStack LoRaWAN gateway as a queued downlink.
//
// Requires two environment variables on the deployed function:
//   CHIRPSTACK_API_URL   e.g. https://chirpstack.example.org
//   CHIRPSTACK_API_TOKEN a ChirpStack API token with device-queue access
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { requireMfaAdmin } = require('./authGuards');

if (!getApps().length) {
  initializeApp();
}
const db = getFirestore();

// fPort the boat firmware listens on for configuration downlinks.
const CONFIG_FPORT = 10;

// Fallback livery closure if the fleet_config/livery doc has not been created:
// livery closes mid-October through mid-March.
const DEFAULT_CLOSURE = { enabled: true, start: '10-15', end: '03-15' };

function gatewayConnectionError() {
  return new HttpsError('unavailable', 'Could not reach the LoRaWAN gateway.');
}

function gatewayRejectionError() {
  return new HttpsError('unavailable', 'The LoRaWAN gateway rejected the configuration request.');
}

const DAY_KEYS = {
  monday: 'mo',
  tuesday: 'tu',
  wednesday: 'we',
  thursday: 'th',
  friday: 'fr',
  saturday: 'sa',
  sunday: 'su'
};

exports.pushBoatConfig = onCall({
  enforceAppCheck: true,
  secrets: ['CHIRPSTACK_API_TOKEN'],
  serviceAccount: 'cwb-boat-config@cwb-boat-operations-c50dd.iam.gserviceaccount.com'
}, async (request) => {
  await requireMfaAdmin(request);

  const {
    id,
    vesselName,
    boatType,
    availability,
    reportIntervalMinutes,
    seasonStart,
    seasonEnd,
    schedule
  } = request.data || {};

  if (!/^[0-9a-f]{16}$/i.test(id || '')) {
    throw new HttpsError('invalid-argument', 'A 16-character hexadecimal Device ID is required.');
  }
  const interval = Number(reportIntervalMinutes);
  if (!Number.isInteger(interval) || interval < 1 || interval > 60) {
    throw new HttpsError('invalid-argument', 'Reporting interval must be a whole number from 1 to 60 minutes.');
  }

  const baseUrl = process.env.CHIRPSTACK_API_URL;
  const apiToken = process.env.CHIRPSTACK_API_TOKEN;
  if (!baseUrl || !apiToken) {
    throw new HttpsError(
      'failed-precondition',
      'The LoRaWAN gateway is not configured.'
    );
  }

  // Compact JSON keeps the downlink well inside LoRaWAN payload limits at
  // moderate data rates. The firmware assembles its boat identity from this.
  // The livery closure is read server-side so every push carries the current
  // fleet-wide off-season window — trackers deep-sleep through it to save power.
  let closure = DEFAULT_CLOSURE;
  try {
    const closureSnap = await db.collection('fleet_config').doc('livery').get();
    if (closureSnap.exists) {
      const data = closureSnap.data() || {};
      closure = {
        enabled: data.closure_enabled !== false,
        start: /^\d{2}-\d{2}$/.test(data.closure_start || '') ? data.closure_start : DEFAULT_CLOSURE.start,
        end: /^\d{2}-\d{2}$/.test(data.closure_end || '') ? data.closure_end : DEFAULT_CLOSURE.end
      };
    }
  } catch (error) {
    console.warn('Could not read livery closure config; using defaults.', error);
  }

  const payload = {
    v: 1,
    id: id.toLowerCase(),
    nm: String(vesselName || '').slice(0, 60),
    tp: String(boatType || '').slice(0, 40),
    av: availability === 'available' ? 1 : 0,
    ri: interval,
    rs: String(seasonStart || ''),
    re: String(seasonEnd || ''),
    // Livery closure: [enabled, start MM-DD, end MM-DD], recurring annually.
    lc: [closure.enabled ? 1 : 0, closure.start, closure.end],
    wh: {}
  };
  for (const [day, window] of Object.entries(schedule || {})) {
    const key = DAY_KEYS[day];
    if (!key || typeof window !== 'object' || window === null) continue;
    payload.wh[key] = [window.enabled ? 1 : 0, String(window.start || ''), String(window.end || '')];
  }

  const json = JSON.stringify(payload);
  const queueUrl = `${baseUrl.replace(/\/+$/, '')}/api/devices/${payload.id}/queue`;
  let response;
  try {
    response = await fetch(queueUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // ChirpStack v4 REST gateway accepts either header form.
        'Authorization': `Bearer ${apiToken}`,
        'Grpc-Metadata-Authorization': `Bearer ${apiToken}`
      },
      body: JSON.stringify({
        queueItem: {
          fPort: CONFIG_FPORT,
          confirmed: true,
          data: Buffer.from(json, 'utf8').toString('base64')
        }
      })
    });
  } catch (error) {
    console.error('ChirpStack queue request failed.', { name: error.name });
    throw gatewayConnectionError();
  }

  if (!response.ok) {
    console.error('ChirpStack rejected a queue request.', { status: response.status });
    throw gatewayRejectionError();
  }

  const body = await response.json().catch(() => ({}));
  return {
    queued: true,
    deviceId: payload.id,
    queueItemId: body.id || null,
    fPort: CONFIG_FPORT,
    bytes: Buffer.byteLength(json, 'utf8')
  };
});

module.exports.gatewayConnectionError = gatewayConnectionError;
module.exports.gatewayRejectionError = gatewayRejectionError;

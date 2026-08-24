import { ok, badRequest, forbidden, serverError } from 'wix-http-functions';
import { secrets } from 'wix-secrets-backend.v2';
import { elevate } from 'wix-auth';
import wixData from 'wix-data';

const SUPPORTED_PROTOCOL_VERSION = 1;
const V1_PAYLOAD_LENGTH = 16;
const getSecretValue = elevate(secrets.getSecretValue);

export async function post_telemetryIngest(request) {
    try {
        const expectedToken = await getSecretValue('chirpstackWebhookToken');
        if (request.headers['x-cwb-webhook-token'] !== expectedToken) {
            return forbidden({ body: "Forbidden." });
        }
        if (request.query.event && request.query.event !== 'up') {
            return ok({ body: "Event ignored." });
        }

        const payload = await request.body.json();
        if (!payload) {
            return badRequest({ body: "Missing uplink event body." });
        }

        const boatId = payload.deviceInfo?.devEui
            || payload.dev_eui
            || payload.device_id;
        const base64Payload = payload.data || payload.payload_raw;
        if (!boatId || !base64Payload) {
            return badRequest({ body: "Missing device identity or base64 uplink data." });
        }

        const buffer = Buffer.from(base64Payload, 'base64');

        if (buffer.length < 1) {
            return badRequest({ body: "Malformed data frame size." });
        }

        const protocolVersion = buffer.readUInt8(0);
        if (protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
            return badRequest({ body: `Unsupported telemetry protocol version: ${protocolVersion}.` });
        }
        if (buffer.length !== V1_PAYLOAD_LENGTH) {
            return badRequest({ body: "Malformed version 1 data frame size." });
        }

        const lat = buffer.readInt32LE(1) / 10000000;
        const lon = buffer.readInt32LE(5) / 10000000;
        const battMv = buffer.readUInt16LE(9);
        const varianceRaw = buffer.readUInt16LE(11);
        const maxTempCentiC = buffer.readInt16LE(13);
        const flags = buffer.readUInt8(15);

        const motionVariance = varianceRaw / 100000.0;
        const lowBatteryAlert = (flags & 0x01) === 0x01;
        const gpsFixFound = (flags & 0x02) === 0x02;
        const isTiedUp = (flags & 0x04) === 0x04;
        const thermalValid = (flags & 0x08) === 0x08;
        const mooringClassificationValid = (flags & 0x10) === 0x10;
        const mooringStatus = !gpsFixFound
            ? "Unknown"
            : !mooringClassificationValid
                ? "Outside Dock Geofence"
                : isTiedUp
                    ? "Tied Up at Dock"
                    : "Underway at Dock";

        const dbRow = {
            title: boatId,
            protocolVersion,
            latitude: lat,
            longitude: lon,
            batteryMv: battMv,
            variance: mooringClassificationValid ? motionVariance : null,
            statusString: mooringStatus,
            lowBattery: lowBatteryAlert,
            gpsFix: gpsFixFound,
            insideDockGeofence: mooringClassificationValid,
            mooringClassificationValid,
            maxTemperatureC: thermalValid ? maxTempCentiC / 100 : null,
            timestamp: new Date()
        };

        const options = {
            "suppressAuth": true, // SAFELY BYPASS 'Admin Only' restriction inside secure backend scope
            "suppressHooks": false
        };

        await wixData.insert("VesselTelemetry", dbRow, options);
        return ok({ headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "Success" }) });

    } catch (err) {
        return serverError({ body: "Wix Engine Process Exception: " + err.toString() });
    }
}

import { ok, badRequest, serverError } from 'wix-http-functions';
import wixData from 'wix-data';

export async function post_telemetryIngest(request) {
    try {
        const payload = await request.body.json();
        if (!payload || !payload.payload_raw) {
            return badRequest({ body: "Missing raw data payload arrays." });
        }

        const boatId = payload.dev_eui || payload.device_id;
        const buffer = Buffer.from(payload.payload_raw, 'base64');

        if (buffer.length < 15) {
            return badRequest({ body: "Malformed data frame size." });
        }

        // Unpack structured binary layout mapping the C++ compiler arrangement
        const lat = buffer.readInt32LE(0) / 10000000;
        const lon = buffer.readInt32LE(4) / 10000000;
        const battMv = buffer.readUInt16LE(8);
        const varianceRaw = buffer.readUInt16LE(10);
        const maxTempCentiC = buffer.readInt16LE(12);
        const flags = buffer.readUInt8(14);

        const motionVariance = varianceRaw / 100000.0;
        const lowBatteryAlert = (flags & 0x01) === 0x01;
        const gpsFixFound = (flags & 0x02) === 0x02;
        const isTiedUp = (flags & 0x04) === 0x04;
        const thermalValid = (flags & 0x08) === 0x08;

        const dbRow = {
            title: boatId, 
            latitude: lat,
            longitude: lon,
            batteryMv: battMv,
            variance: motionVariance,
            statusString: isTiedUp ? "Tied Up at Dock" : "Underway / Moving",
            lowBattery: lowBatteryAlert,
            gpsFix: gpsFixFound,
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

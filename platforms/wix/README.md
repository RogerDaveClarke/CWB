# Marine Fleet Telemetry & Mooring Detection Architecture

This production-grade system bundle migrates the Center for Wooden Boats (CWB) fleet tracker platform away from complex GCP cloud hosting into your native **Wix Velo Workspace**. It delivers a high-utility, ultra-low-overhead pipeline for edge tracking, hardware physical data verification, and automatic database maintenance routines.

---

## ⚓ The Mooring Detection Algorithm

Waves, river channels, and lake tides cause continuous baseline kinetic displacements. The edge hardware separates ambient environmental drift from true human boarding actions or rowing via a **Signal Magnitude Variance ($\\sigma^2$) Matrix Pipeline**.

### 1. Orientation Neutral Force Vectors
To eliminate errors introduced by random structural placement inside boat hulls, 3-axis readings ($a_x, a_y, a_z$) extracted from the Adafruit LIS3DH are reduced to an orientation-neutral scalar vector magnitude:
$$ |a| = \\sqrt{a_x^2 + a_y^2 + a_z^2} $$

### 2. High-Frequency Time Windows
The SAMD21 microprocessor executes a wake phase every 15 minutes, fires up the accelerometer bus channel to **10Hz**, and records sequential observations for a $3$-second capture timeline interval ($N = 30$ data snapshots):
$$ \\mu = \\frac{1}{N} \\sum_{i=1}^{N} |a|_i $$

### 3. Energy Variance Classifications
The firmware runs this classifier only when a valid GPS fix is inside the 55 m CWB dock geofence centered at `47.62795, -122.33645`. Outside this area the accelerometer classifier is not run, preventing calm open-water conditions from being labeled as tied up.

Statistical signal variance is processed across the compiled sampling slice:
$$ \\sigma^2 = \\frac{1}{N} \\sum_{i=1}^{N} (|a|_i - \\mu)^2 $$

* **Tied Up at Dock ($\\sigma^2 < 0.025g^2$):** Bumper friction blocks combined with tense, tight mooring ropes absorb kinetic impact energy and hold calculations beneath the boundary limit thresholds.
* **Underway / Moving ($\\sigma^2 \\ge 0.025g^2$):** Dynamic human distribution shifts, gear loading actions, and oar-striking vibrations trigger high-energy signal vectors that exceed the baseline limit.

---

## 🛡️ Role-Based Access Control (RBAC) Protection Schema

To prevent external actors from injecting fake tracking telemetry or altering database rows, your Wix CMS **VesselTelemetry** collection permissions must be set as follows:

* **Read Content:** `Anyone` (allows public site maps and client scripts to query coordinates).
* **Create Content:** `Admin Only` (blocks raw web access endpoints from tampering with records).
* **Update Content:** `Admin Only` (avoids data modification vulnerabilities).
* **Delete Content:** `Admin Only` (restricts system clear commands to site operators).

### Secure Administrative Overrides
Because standard client access is blocked (`Admin Only`), your server backend script safely processes incoming device payloads by calling data overrides inside `backend/http-functions.js`:
```javascript
const options = {
  "suppressAuth": true, // Securely elevates privileges within the sandboxed cloud execution thread
  "suppressHooks": false
};
await wixData.insert("VesselTelemetry", dbRow, options);
```

---

## 🧹 Zero-Maintenance Automated Data Lifecycles

To prevent database bloat and keep Wix collection usage clean, the backend includes an automated pruning routine triggered by the Wix Cron Engine every single night at 2:00 AM. It computes a moving age retention threshold:
$$ \\text{Threshold} = \\text{Current Time} - 30\\text{ Days} $$
All coordinate historical logs falling before this window are permanently removed.

---

## 🛠️ Deployment Steps

1. **Wix CMS Setup:** Open your Wix Editor, toggle **Dev Mode / Velo**, and create a collection named `VesselTelemetry`. Add Number fields `protocolVersion`, `latitude`, `longitude`, `batteryMv`, `variance`, and `maxTemperatureC`; Boolean fields `lowBattery`, `gpsFix`, `insideDockGeofence`, and `mooringClassificationValid`; Text field `statusString`; and Date and Time field `timestamp`.
2. **Backend Copy:** Copy the files from `backend/` (`http-functions.js`, `data-cleanup.js`, `jobs.config`) directly into your Wix Backend Explorer pane.
3. **Frontend Map Assembly:** Create a site page, drop a **Custom Element** component wrapper box down, assign its script path source to `frontend/custom-element-leaflet.js`, and attach `frontend/page-code.js` to the main code page view layout container.
4. **Webhook Authentication:** Add a Wix secret named `chirpstackWebhookToken` containing a random high-entropy value. Configure the ChirpStack HTTP integration to send the same value in the `X-CWB-Webhook-Token` header.
5. **LoRaWAN Routing:** Direct the private ChirpStack application webhook to your published Wix API address: `https://yourdomain.com/_functions/telemetryIngest`.

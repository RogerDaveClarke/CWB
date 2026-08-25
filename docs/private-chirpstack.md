# Private ChirpStack Deployment

This is the target LoRaWAN network model for CWB. It removes the recurring public LoRaWAN network dependency while keeping GCP and Wix as interchangeable application destinations.

## Topology

```text
Boat tracker (US915 LoRaWAN OTAA)
    -> outdoor LoRaWAN gateway
    -> CWB Ethernet LAN
    -> private ChirpStack v4 server
    -> HTTPS webhook
    -> Phase 1: GCP Cloud Function and Firestore
       Phase 2: Wix Velo backend and CMS
```

The tracker transmits a versioned 16-byte LoRaWAN application payload. It does not know the gateway, ChirpStack server, webhook URL, GCP, or Wix. Moving from GCP to Wix is a ChirpStack integration change only.

## Host Requirements

Use an always-on Linux computer or server inside the boathouse with:

* A static LAN address or DHCP reservation.
* Docker Engine and Docker Compose.
* Wired Ethernet where possible.
* Persistent storage included in regular backups.
* A UPS for the server, network switch, router, and gateway.
* Outbound HTTPS access for GCP or Wix webhooks.

Do not expose the ChirpStack UI, PostgreSQL, Redis, or MQTT broker directly to the public internet. A local ChirpStack server does not require inbound internet access to call a public GCP or Wix webhook; it initiates the outbound HTTPS request.

## Install ChirpStack v4

Use ChirpStack's maintained Docker Compose example rather than copying its infrastructure into this application repository:

```bash
git clone https://github.com/chirpstack/chirpstack-docker.git
cd chirpstack-docker
```

Before starting it:

1. Enable the US915 region and disable the default EU868 region by following the example repository's current configuration instructions.
2. Set durable PostgreSQL, Redis, and MQTT credentials.
3. Restrict host firewall access to the CWB LAN.
4. Decide whether the gateway will use Basics Station or the Semtech UDP packet forwarder.

Start the stack:

```bash
docker compose up -d
docker compose ps
```

Open `http://SERVER_LAN_IP:8080` from the CWB LAN, sign in, and immediately replace the default administrator credentials.

## Connect the Gateway

Use the gateway's wired Ethernet connection for normal operation. Cellular backhaul introduces a recurring charge and should be reserved for a separately approved failover requirement.

### Preferred: Semtech Basics Station

If the gateway firmware supports Basics Station, point it to the ChirpStack Gateway Bridge listener on:

```text
ws://SERVER_LAN_IP:3001
```

Use `wss://` with managed certificates if traffic leaves the trusted LAN. Basics Station provides a better security and connection-management foundation than unauthenticated UDP.

### Fallback: Semtech UDP Packet Forwarder

Configure the gateway packet forwarder with:

```json
{
  "gateway_conf": {
    "server_address": "SERVER_LAN_IP",
    "serv_port_up": 1700,
    "serv_port_down": 1700
  }
}
```

Allow UDP port `1700` from the gateway IP to the ChirpStack host. Do not expose this port to the public internet.

In ChirpStack, register the gateway using the exact gateway EUI shown by the gateway. Confirm that its Last seen value updates before configuring a tracker.

## Register the Tracker

Create a tenant, application, and device profile in ChirpStack. Configure the device profile to match the installed RadioLib reference:

* Region: US915.
* LoRaWAN MAC version: 1.1.0.
* Regional Parameters: RP001 1.1 revision A.
* Activation: OTAA.
* Device class: Class A.

Create the device using the firmware `devEui`. Configure the same `joinEui`, `appKey`, and `nwkKey` in ChirpStack and the tracker. Keep production keys outside Git.

After flashing, verify a successful join and an uplink on FPort 1. The application payload is already decoded by the GCP or Wix adapter; a ChirpStack codec is not required.

## Configure the Reporting Interval

The tracker reports every 3 minutes by default. It accepts an unconfirmed
Class A downlink on FPort 2 containing exactly one unsigned byte. The byte is
the interval in minutes; valid values are 1 through 60.

In the ChirpStack device queue, enqueue the command for the matching DevEUI. It
will be delivered in the receive windows following the device's next uplink.
For example:

| Interval | Hex payload | Base64 payload |
| :--- | :--- | :--- |
| 3 minutes | `03` | `Aw==` |
| 15 minutes | `0F` | `Dw==` |
| 60 minutes | `3C` | `PA==` |

The GCP admin page stores `report_interval_minutes` as the intended value for
each boat. Saving that record does not enqueue a ChirpStack command because the
private ChirpStack server is not reachable from Firebase Hosting. Queue the
matching FPort 2 command from the CWB LAN after changing the admin value.

## Configure the HTTP Integration

Configure ChirpStack's HTTP integration to use JSON. ChirpStack appends an `event` query parameter and sends uplinks as `event=up`. The adapters accept the ChirpStack v4 fields:

```json
{
  "deviceInfo": {
    "devEui": "70b3d57ed0000001"
  },
  "fPort": 1,
  "data": "BASE64_ENCODED_16_BYTE_PAYLOAD"
}
```

Generate one random high-entropy webhook token. Store it as:

* GCP Secret Manager secret `chirpstack-webhook-token`, exposed to the function as `CHIRPSTACK_WEBHOOK_TOKEN`.
* Wix Secrets Manager secret `chirpstackWebhookToken`.

Configure the ChirpStack HTTP integration to send this header:

```text
X-CWB-Webhook-Token: YOUR_SECRET_VALUE
```

The public adapters reject requests without the matching token. Do not put the token in Git or in the endpoint URL.

For the POC, set the endpoint to the deployed GCP function URL. After CWB approves Wix, replace that endpoint with:

```text
https://yourdomain.com/_functions/telemetryIngest
```

No gateway or tracker configuration changes are required for this cutover. Keep GCP available during Wix validation, then disable the GCP integration after end-to-end Wix verification.

## Firewall Matrix

| Source | Destination | Port | Purpose |
| :--- | :--- | :--- | :--- |
| CWB administrator LAN | ChirpStack host | TCP 8080 | Administration UI |
| Gateway | ChirpStack host | TCP 3001 | Basics Station |
| Gateway | ChirpStack host | UDP 1700 | Semtech UDP fallback |
| ChirpStack containers | MQTT broker | TCP 1883 | Internal event transport |
| ChirpStack host | GCP or Wix | TCP 443 | Outbound webhook |

Only open the gateway protocol actually in use. Keep PostgreSQL, Redis, and MQTT private to the host or container network.

## Production Checks

1. Reboot the server and confirm all ChirpStack containers restart automatically.
2. Disconnect and restore the internet; local joins and uplinks should resume independently of the application webhook.
3. Confirm successful OTAA join, frame-counter progression, and 16-byte uplinks.
4. Confirm the GCP or Wix record contains `protocolVersion` 1 and the expected device EUI.
5. Back up and restore the ChirpStack database in a test environment.
6. Monitor disk usage, container health, gateway last-seen time, join failures, and webhook failures.
7. Ground the outdoor gateway and antenna system, add an appropriate lightning arrestor, weatherproof every RF connection, and comply with US915 installation requirements.

ChirpStack removes network subscription fees, but the deployment still has hardware, electricity, backup, maintenance, and any chosen internet or cellular costs.
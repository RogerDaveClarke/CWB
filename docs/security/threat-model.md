# CWB GCP Threat Model

**Owner:** CWB technical lead

**Review cadence:** Quarterly and after any new endpoint, data category, identity provider, or trust boundary

**Last reviewed:** 2026-09-15

## Assets

- Renter identity, precise GPS trails, party size, and rental timestamps.
- Staff identities, roles, MFA enrollment, and session tokens.
- Staff invitation email addresses, suspension notices, and account deletion state.
- ChirpStack webhook and API credentials.
- Boat configuration, telemetry integrity, production source, and deployment authority.

## Trust Boundaries

1. The selected tracker architecture uses a XIAO SAMD21, NEO-M9N, Wio-SX1262,
   MicroSD, six-axis IMU, analog battery divider, and four-cell NiCd pack.
   Tracker-to-ChirpStack communication uses LoRaWAN OTAA. Device provisioning,
   physical protection, key rotation, and lost-device revocation remain pending
   before field deployment.
2. ChirpStack to `telemetryIngest` crosses the public internet and uses a Secret Manager credential, request constraints, replay receipts, and bounded retention.
3. Browser to Firebase crosses an untrusted client boundary and requires Firebase Auth, role checks, TOTP for mutation, App Check, and Firestore Rules.
4. Invitation and lifecycle email crosses the Firebase/Gmail SMTP boundary. Role activation requires an administrator invitation, verified matching email, UID binding, and TOTP enrollment; the dedicated Gmail address, app password, and lifecycle encryption key remain in Secret Manager. Notification content is encrypted at rest while queued for bounded retry.
5. Cloud Functions use the Admin SDK and therefore bypass Firestore Rules; privileged callables require current token claims to agree with the active live profile and Auth record.
6. GitHub Actions and local hooks are software-supply-chain boundaries. CI uses least permissions, immutable action revisions, audits, CodeQL, secret scanning, and SBOM evidence.

## Principal Threats And Controls

| Threat | Prevent | Detect | Contain/Recover |
| :--- | :--- | :--- | :--- |
| Anonymous or cross-role data access | Auth, App Check, MFA, Rules, callable guards | Denied-request alerts and audit logs | Revoke sessions and correct claims/rules |
| Forged or replayed telemetry | Webhook secret, strict request validation, replay receipt | 403/429 and volume alerts | Rotate secret and disable integration |
| Endpoint added without authorization | Endpoint inventory and blocking security gate | CI failure | Block merge/deploy |
| Compromised runtime | Dedicated least-privilege service accounts | SCC, audit logs, anomalous secret access | Disable service, rotate secrets, redeploy |
| Dependency or CI compromise | Lockfiles, audits, CodeQL, pinned Actions, SBOM | Dependabot and GitHub alerts | Revert, upgrade, rebuild from reviewed commit |
| Data retained after rental | Atomic server check-in and scheduled 48-hour purge | Privacy gate and purge logs | Run purge and investigate failed schedule |
| Malicious or accidental admin action | MFA and separation of duties | Admin Activity/Data Access logs | Revoke account, restore configuration |
| Accidental or unauthorized account suspension/deletion | MFA-admin guard, exact-email confirmation, required suspension reason | Pseudonymous lifecycle security events | Restore a suspended account; deletion is intentionally irreversible |
| Account pre-hijacking or MFA factor planting | Admin-only invitation, verified-email and UID binding, no role claims before TOTP | Invitation lifecycle security events | Cancel invitation and revoke sessions |
| Availability/cost attack | Payload and instance limits; Cloud Armor planned | Request-volume, latency, error, and budget alerts | Rate-limit/block source and invoke incident plan |

## Security Invariants

- No GCP HTTP/callable export exists outside `tools/security-gate/gcp-endpoints.json`.
- No operational Firestore collection permits anonymous or unassigned-account access.
- Browser callables enforce App Check except invitation acceptance and completion. Those capacity-capped endpoints are reached only after Firebase verifies mailbox control, require a high-entropy one-time invitation token and matching UID, and require an enrolled TOTP factor before completion. ChirpStack uses its separate machine credential.
- No production workload runs as a default service account or receives `Editor`/`Owner`.
- The default Compute identity is restricted to the Cloud Build builder role and is never a runtime identity.
- GPS history is erased at check-in and is never retained longer than 48 hours.
- Secrets, tokens, renter names, and coordinates are not written to application logs.
- Raw invitation tokens are never stored; deleted accounts lose Auth, MFA, profile subcollections, and linked invitation records.
- Suspension and deletion notices use encrypted, idempotent lifecycle jobs with a 24-hour retry window; recipient emails and suspension reasons are not logged.

## Hardware Boundary

The primary hardware classes are selected, but the exact six-axis IMU,
regulator, voltage-divider values, and wake source remain open. Before field
deployment, review MicroSD data-at-rest exposure, debug-port protection,
firmware authenticity and update procedures, OTAA key injection and rotation,
device inventory, tamper response, and lost-device revocation. MicroSD must not
become an uncontrolled long-term copy of renter-linked precise location data;
its retention, overwrite behavior, and physical recovery procedure require a
documented decision before logging is enabled.
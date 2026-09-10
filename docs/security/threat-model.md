# CWB GCP Threat Model

**Owner:** CWB technical lead

**Review cadence:** Quarterly and after any new endpoint, data category, identity provider, or trust boundary

**Last reviewed:** 2026-09-10

## Assets

- Renter identity, precise GPS trails, party size, and rental timestamps.
- Staff identities, roles, MFA enrollment, and session tokens.
- ChirpStack webhook and API credentials.
- Boat configuration, telemetry integrity, production source, and deployment authority.

## Trust Boundaries

1. Tracker to private ChirpStack uses LoRaWAN security and is deferred until hardware exists.
2. ChirpStack to `telemetryIngest` crosses the public internet and uses a Secret Manager credential, request constraints, replay receipts, and bounded retention.
3. Browser to Firebase crosses an untrusted client boundary and requires Firebase Auth, role checks, TOTP for mutation, App Check, and Firestore Rules.
4. Cloud Functions use the Admin SDK and therefore bypass Firestore Rules; each callable repeats authorization server-side and runs as a dedicated service account.
5. GitHub Actions and local hooks are software-supply-chain boundaries. CI uses least permissions, immutable action revisions, audits, CodeQL, secret scanning, and SBOM evidence.

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
| Availability/cost attack | Payload and instance limits; Cloud Armor planned | Request-volume, latency, error, and budget alerts | Rate-limit/block source and invoke incident plan |

## Security Invariants

- No GCP HTTP/callable export exists outside `tools/security-gate/gcp-endpoints.json`.
- No operational Firestore collection permits anonymous or unassigned-account access.
- Browser callables enforce App Check; ChirpStack uses its separate machine credential.
- No production workload runs as a default service account or receives `Editor`/`Owner`.
- The default Compute identity is restricted to the Cloud Build builder role and is never a runtime identity.
- GPS history is erased at check-in and is never retained longer than 48 hours.
- Secrets, tokens, renter names, and coordinates are not written to application logs.

## Deferred Hardware Boundary

Device provisioning, physical debug protection, secure boot, signed firmware updates, OTAA key rotation, and lost-device revocation remain out of scope until hardware is selected. They must be reviewed before field deployment.
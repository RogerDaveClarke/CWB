# GCP Security Operations

Project: `cwb-boat-operations-c50dd`; primary region: `us-west1`.

## Enforced Controls

- Dedicated runtime identities: `cwb-telemetry-ingest`, `cwb-user-admin`, and `cwb-boat-config`.
- The default Compute identity is build-only with `roles/cloudbuild.builds.builder`; it has no `Editor` role and is not used at runtime.
- Secret-level access only for the consuming telemetry, boat-configuration, and account-administration identities.
- Firebase App Check uses a score-based reCAPTCHA Enterprise key restricted to the Firebase Hosting domains.
- Data Read and Data Write audit logs are enabled for all services.
- `security-alert-policy.json` monitors rejected calls, unknown devices, control changes, and purge failures.
- GPS history has a 48-hour scheduled deletion backstop.
- An hourly identity reconciliation compares Firebase Auth disabled/claim state with live Firestore profiles and alerts on drift.
- Forced browser session exits emit pseudonymous security events before local sign-out and reload.

## Release Order

1. Run both gates, Cloud Function tests, and Firestore emulator tests.
2. Add Secret Manager versions interactively; never pass values on a command line or through chat.
	Account lifecycle email requires `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and `LIFECYCLE_NOTIFICATION_KEY`; the sender must be a Resend-verified address or domain. The notification key must be a base64-encoded 32-byte random value and must be retained while lifecycle jobs are pending.
3. Deploy hosting first so browsers begin sending App Check tokens.
4. Review App Check metrics, then deploy callable enforcement and dedicated runtime identities.
5. Verify runtime identities, secret bindings, scheduled purge, security headers, and alert delivery.
6. Remove `Editor` from default runtime identities only after all live functions use dedicated identities.

## Manual Preconditions

- A notification channel must be selected and tested before alerts can page a person.
- Cloud Armor requires an external HTTPS load balancer, serverless NEG, custom endpoint, and tested ChirpStack routing.
- Organization policies and organization-level Security Command Center require moving the project under a CWB Google Cloud organization.
- Backups require an approved retention period, backup project/bucket, and named restore tester.
- Account lifecycle jobs retain only encrypted notification content and retry metadata. Delivery eligibility ends after 24 hours. Successful and observed-expired jobs are deleted immediately; Firestore TTL independently removes expired records asynchronously. Verify the deployed TTL policy because Firestore does not guarantee deletion at the exact expiration instant.
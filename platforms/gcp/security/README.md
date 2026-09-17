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

## Local App Check

Production reCAPTCHA Enterprise keys are restricted to Firebase Hosting domains,
so localhost must use a registered App Check debug token. Generate a random token
into `FIREBASE_APP_CHECK_DEBUG_TOKEN` in ignored `local.env`, then have a project
App Check administrator register that value for the Firebase web app under
**Firebase Console > App Check > Apps > Manage debug tokens**. Restart
`npm run dev` after changing `local.env`.

Debug tokens are development credentials. Never add one to `production.env`,
commit it, paste it into logs, or use it from a non-loopback origin. The frontend
rejects configured debug tokens outside `localhost`, `127.0.0.1`, and `::1`.

## Release Order

1. Run both gates, Cloud Function tests, and Firestore emulator tests.
2. Add Secret Manager versions interactively; never pass values on a command line or through chat.
	Account lifecycle email requires `GMAIL_SENDER_EMAIL`, `GMAIL_APP_PASSWORD`, and `LIFECYCLE_NOTIFICATION_KEY`. Use a dedicated Gmail mailbox with 2-Step Verification and an App Password; no owned domain or paid email provider is required for the POC. The notification key must be a base64-encoded 32-byte random value and must be retained while lifecycle jobs are pending.
3. Deploy hosting first so browsers begin sending App Check tokens.
4. Review App Check metrics, then deploy callable enforcement and dedicated runtime identities.
5. Verify runtime identities, secret bindings, scheduled purge, security headers, and alert delivery.
6. Remove `Editor` from default runtime identities only after all live functions use dedicated identities.

## Manual Preconditions

- A notification channel must be selected and tested before alerts can page a person.
- Cloud Armor requires an external HTTPS load balancer, serverless NEG, custom endpoint, and tested ChirpStack routing.
- Organization policies and organization-level Security Command Center require moving the project under a CWB Google Cloud organization.
- Backups require an approved retention period, backup project/bucket, and named restore tester.
- Account lifecycle jobs retain only encrypted notification content and retry metadata. Delivery eligibility ends after 24 hours. The scheduler deletes successful and completed-expired notification jobs; only unfinished suspension operations remain encrypted and queued until completion. Account deletion completes before success is returned, and any deletion outbox record is notification-only and already marked complete.
# GCP Security Operations

Project: `cwb-boat-operations-c50dd`; primary region: `us-west1`.

## Enforced Controls

- Dedicated runtime identities: `cwb-telemetry-ingest`, `cwb-user-admin`, and `cwb-boat-config`.
- The default Compute identity is build-only with `roles/cloudbuild.builds.builder`; it has no `Editor` role and is not used at runtime.
- Secret-level access only for the consuming telemetry and boat-configuration identities.
- Firebase App Check uses a score-based reCAPTCHA Enterprise key restricted to the Firebase Hosting domains.
- Data Read and Data Write audit logs are enabled for all services.
- `security-alert-policy.json` monitors rejected calls, unknown devices, control changes, and purge failures.
- GPS history has a 48-hour scheduled deletion backstop.

## Release Order

1. Run both gates, Cloud Function tests, and Firestore emulator tests.
2. Add Secret Manager versions interactively; never pass values on a command line or through chat.
3. Deploy hosting first so browsers begin sending App Check tokens.
4. Review App Check metrics, then deploy callable enforcement and dedicated runtime identities.
5. Verify runtime identities, secret bindings, scheduled purge, security headers, and alert delivery.
6. Remove `Editor` from default runtime identities only after all live functions use dedicated identities.

## Manual Preconditions

- A notification channel must be selected and tested before alerts can page a person.
- Cloud Armor requires an external HTTPS load balancer, serverless NEG, custom endpoint, and tested ChirpStack routing.
- Organization policies and organization-level Security Command Center require moving the project under a CWB Google Cloud organization.
- Backups require an approved retention period, backup project/bucket, and named restore tester.
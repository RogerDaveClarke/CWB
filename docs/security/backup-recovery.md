# Backup And Recovery

## Recovery Objectives

- Configuration and staff authorization data: target RPO 24 hours, RTO 4 hours.
- Live telemetry: best effort; GPS history is intentionally short-lived and must not be restored past its retention period.
- Source and deployment configuration: recover from protected Git history and CI artifacts.

## Scope

Back up `boats` configuration fields, `boat_types`, `fleet_config`, and `users` profiles. Exclude `_ingest_receipts` and expired GPS history. Treat `rental_history` as sensitive pseudonymous data and retain it only under an approved business schedule.

## Procedure

1. Export Firestore to a dedicated backup bucket in the approved US location using a backup-only service account.
2. Enable uniform bucket-level access, public access prevention, versioning, retention, and restricted deletion permissions.
3. Keep backup administration separate from application runtime identities.
4. Log and alert on export, restore, IAM, retention, and deletion operations.
5. Quarterly, restore into a non-production project, verify document counts and authorization, then delete the test copy under an approved change.
6. Never restore expired GPS trails or overwrite production without an incident/change record and explicit approval.

The bucket name, retention duration, notification channel, and non-production restore project must be approved before provisioning. A documented command is not evidence of recoverability; the quarterly restore record is.
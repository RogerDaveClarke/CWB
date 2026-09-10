# Security Incident Response

**Incident commander:** CWB technical lead

**Privacy/legal contact:** CWB executive owner and counsel
**Exercise cadence:** Twice yearly

## Severity

- **SEV-1:** Active exposure of renter location/identity, administrator compromise, malicious deployment, or broad service-account compromise.
- **SEV-2:** Exposed webhook credential, repeated unauthorized access, exploitable dependency, or unexplained telemetry manipulation.
- **SEV-3:** Blocked attack, expired dependency, policy drift, or isolated availability issue without data exposure.

## First Hour

1. Open an incident record with UTC timestamps and appoint an incident commander.
2. Preserve Cloud Audit, Functions, Firestore, Authentication, Secret Manager, and GitHub logs. Do not place renter data or secrets in chat/tickets.
3. Contain the affected path: disable the integration or user, revoke refresh tokens, rotate the affected secret, or roll back the deployment.
4. Determine whether named renters, precise location, minors, staff data, or credentials were accessed.
5. Contact counsel before making breach-notification conclusions. RCW 19.255.010 and COPPA timelines may apply.

## Playbooks

| Event | Containment | Recovery evidence |
| :--- | :--- | :--- |
| Staff/admin account compromise | Disable account, revoke tokens, remove claims, review user/admin audit events | Fresh MFA enrollment and access review |
| Webhook secret exposure | Create new Secret Manager version, update ChirpStack, disable old version | Valid signed/secret request succeeds; old credential fails |
| Malicious deployment | Disable affected revision, restore reviewed revision, revoke deployer sessions | Provenance, commit, and CodeQL/security gates pass |
| Location disclosure | Stop reads/ingest as needed, preserve evidence, identify affected rentals | Rules tests pass; trails purged; counsel decision recorded |
| Dependency compromise | Pin/remove dependency, rebuild lockfile and SBOM | Audit, CodeQL, Snyk, and behavior tests pass |

## Closure

Record root cause, affected data and interval, control failures, remediation owner, deadlines, notification decision, and a follow-up test. Update the threat model and risk register before closing.
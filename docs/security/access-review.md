# Identity And Access Review

Perform quarterly and after staff departure, administrator change, or service-account change.

1. Export Firebase Auth users, custom claims, MFA enrollment, disabled state, and last sign-in.
2. Confirm every account has a current CWB owner and minimum role/function level.
3. Disable dormant or unowned accounts; revoke refresh tokens after role reduction or suspension.
4. Confirm administrators use TOTP and retain only the minimum number of admin accounts.
5. Review project IAM for users, groups, service accounts, public principals, and basic roles.
6. Confirm production functions use only the three named CWB runtime identities.
7. Confirm no user-managed service-account keys exist.
8. Review Secret Manager access and recent secret-version access logs.
9. Record reviewer, date, removals, exceptions, and next review date in the change record.

Separation of duties: a person should not approve their own new administrator access or security exception. Emergency access must be time-limited and reviewed after use.
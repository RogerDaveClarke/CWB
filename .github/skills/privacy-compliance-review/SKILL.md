---
name: privacy-compliance-review
description: >-
  Review the CWB rowboat tracker for Washington State and US federal privacy
  exposure. Use when changing anything that collects, stores, displays, shares,
  or deletes renter identity, GPS coordinates, thermal/occupancy readings, or
  rental records; when editing firestore.rules, the ingest function, the
  dashboard rental lifecycle, or the retention log; or when the privacy gate
  reports a finding. Also use before a release or a GCP-to-Wix migration.
---

# Privacy Compliance Review

This system tracks the precise location of named members of the public on Lake
Union. Washington's My Health My Data Act carries a **private right of action**
through the Consumer Protection Act (RCW 19.373.090), so mistakes here are not
theoretical.

You are not counsel. Produce engineering findings mapped to statutes and say
plainly when a question needs a lawyer. Never state that the system "complies".

## Run the deterministic gate first

```bash
node tools/privacy-gate/privacy-gate.mjs
```

It runs automatically before firmware builds and the Firebase deploy task, and
in CI. It catches known regressions; it does **not** replace judgement about new
data flows. Full analysis: `docs/privacy-compliance-review.md`.

## The four rules that must never regress

1. **Purpose limitation.** GPS breadcrumbs are retained only while
   `tracking_enabled` is true on the boat document. The gate is server-side in
   `platforms/gcp/cloud-ingest/index.js`. A client-only gate is not a gate.
2. **Erasure at check-in.** Check-in deletes `boats/{id}/history` and clears
   `booked_by`, `passenger_count`, and `time_out`.
3. **Retention allowlist.** `rental_history` is constrained by `hasOnly()` in
   `firestore.rules`. Adding an identity or location key there is a blocking
   finding, not a judgement call.
4. **Accurate claims.** The retained log keeps a per-boat identifier and exact
   times, so it is **pseudonymous, not anonymous**. Do not describe it as
   anonymised or deidentified. Overstating erasure is an FTC Act s5 deception
   risk and a per se CPA violation via RCW 19.373.090.

## Reviewing a change

Ask, in order:

1. **Does it add a new category of personal data?** Precise location, body
   heat, identity, and party size are all in scope. New categories require a
   disclosure and consent change, not just code (RCW 19.373.020(1)(c)-(d)).
2. **Who can read it?** `allow read: if true` on any path holding identity or
   location is a critical finding. Firestore has no field-level read control,
   so identity and public data must live in **separate documents**.
3. **When is it deleted, and what guarantees that?** A deletion that depends on
   a browser staying open is not a guarantee. Prefer server-side deletion and a
   scheduled backstop.
4. **Does any UI text now overstate what happens?** Match wording to behaviour
   exactly.
5. **Could a minor be the subject?** CWB runs youth programs. Precise
   geolocation plus a name for a child under 13 triggers COPPA verifiable
   parental consent (16 CFR 312.5).

## Statutes that actually bite here

| Source | Why it applies |
| :--- | :--- |
| RCW 19.373 (MHMDA) | "Precise location" is within 1,750 ft. "Health care services" includes any service to "assess, measure, improve, or learn about" physical health. Whether recreational rowing qualifies is genuinely unsettled — flag it, do not assume either way. |
| RCW 19.373.090 + RCW 19.86 | An MHMDA violation is a per se unfair/deceptive act with a private right of action. |
| FTC Act s5 (15 U.S.C. 45) | Deceptive privacy claims. The FTC has repeatedly treated precise location as sensitive. |
| COPPA (16 CFR 312) | Geolocation identifying street and town is personal information for under-13s. |
| RCW 19.255.010 | Breach notification. Publicly readable name plus location may itself be a reportable exposure. |
| RCW 19.375 | Biometric identifiers. An 8x8 thermal array cannot identify an individual today; raising its resolution changes that analysis. |

## Recording an exception

If a finding cannot be fixed now, add an entry to `acknowledged` in
`tools/privacy-gate/privacy-policy.json` with `id`, `owner`, `reason`, and
`reviewBy`. Acknowledgements **expire**: past `reviewBy`, the build fails. Never
silence a finding by deleting its rule or widening a pattern.

## Output format

Report each finding as: severity, what the code does, the statute it implicates,
and the smallest change that resolves it. Separate "this is a violation" from
"this depends on a legal determination CWB has not made".

# Privacy Compliance Review

**Scope:** CWB rowboat tracking system — firmware, ChirpStack ingest, GCP/Firestore
platform, operations dashboard, administration and rental history pages.
**Reviewed against:** Washington State and US federal privacy law.
**Date:** 2026-09-15

> **This is an engineering review, not legal advice.** It is written by the
> engineering team to identify risk and drive design decisions. Washington's My
> Health My Data Act carries a private right of action, so CWB should have
> counsel confirm the applicability question in Section 2 before go-live.

---

## 1. What the system actually collects

| Data | Where it lives | Linked to a person? |
| :--- | :--- | :--- |
| Renter full name (`booked_by`) | `boats/{DevEUI}` | Directly identifying |
| Precise GPS, configurable 1–60 min cadence (3 min current default; 5 min target) | `boats/{DevEUI}/history`, `last_ping` | Yes, while checked out |
| Party size (`passenger_count`) | `boats/{DevEUI}`, `rental_history` | Indirectly |
| Max thermal pixel (`max_temperature_c`) | Current protocol v1 `last_ping` and trail entries | Body-heat derived; removal planned with the new hardware revision |
| Mooring variance | `last_ping`, trail entries | Behavioural |
| Rental times | `rental_history` | Pseudonymous |
| Staff account email, name, address, role | Firebase Auth, `users/{uid}` | Directly identifying |
| Pending staff invitation details | `user_invitations/{tokenHash}` | Directly identifying |
| Battery service and charge-cycle telemetry | `battery_service_events`, `battery_cycles` | Boat-linked; override actions include a pseudonymous staff identifier |
| Optional MicroSD storage | Target tracker hardware only | Precise location logging is disabled pending retention and physical-recovery rules |

GPS resolution is far finer than the 1,750 ft threshold that makes location
"precise location information" under RCW 19.373.010(19).

Staff accounts are created only through an MFA-administrator invitation. Suspension revokes claims and sessions, disables sign-in, removes Auth display data, recursively erases the live profile and linked invitations, and leaves only the Auth email and a status-only Firestore tombstone needed to keep the identity blocked. Deletion is immediate: the callable recursively removes the live profile and subcollections, removes invitations linked by email or UID, and deletes Firebase Auth and enrolled MFA factors before reporting success. Suspension operations may be retried from the encrypted lifecycle queue, while deletion enters that queue only after erasure and only for notification delivery. Notices cannot be delivered after their 24-hour expiry. Security events retain only a one-way pseudonymous actor identifier; backups remain governed by their separately approved retention schedule, so the product must not claim deletion from already-created backups unless that process is verified.

---

## 2. The threshold question: does MHMDA apply?

This determines the severity of nearly everything below, and **it is genuinely
unsettled**. It needs a legal answer, not an engineering guess.

**CWB is likely a "regulated entity."** RCW 19.373.010(23) covers any legal
entity conducting business in Washington that determines the purpose and means
of collecting consumer health data. Nonprofits are not excluded — only
government agencies and tribal nations are. CWB almost certainly falls in the
"small business" tier (RCW 19.373.010(28)), whose compliance date was
**30 June 2024** and has already passed.

**Whether this is "consumer health data" is the open question.** Two hooks:

1. **RCW 19.373.010(15) defines "health care services" extremely broadly** — any
   service provided to "assess, measure, improve, or learn about a person's
   mental or physical health," expressly including "bodily functions, vital
   signs, symptoms, or measurements." Recreational rowing is exercise. If CWB
   markets rowing in wellness or fitness terms, that materially strengthens the
   argument that it is such a service.
2. **The currently implemented AMG8833 thermal array measures body heat.** Under
   RCW 19.373.010(8)(b)(v), "bodily functions, vital signs, symptoms, or
   measurements" are consumer health data when linked to a consumer. This
   reading currently applies, because the thermal value is stored in the same
   document as the renter's name.

**If MHMDA applies, one consequence is severe.** RCW 19.373.080 makes it
unlawful to operate a geofence within 2,000 ft of an entity providing in-person
health care services in order to identify or track consumers or collect consumer
health data. The dock geofence is 55 m around CWB's own facility and exists
precisely to detect consumers' boats. If CWB is deemed to provide "health care
services," **the mooring geofence itself could be implicated.** No dollar
threshold or intent requirement softens this. Counsel should address it directly.

**Engineering recommendation regardless of the answer:** complete the approved
hardware transition without carrying `max_temperature_c` into protocol v2
unless a documented operational purpose and legal basis are approved. It is the
single field that most strongly pulls this system into MHMDA scope, and nothing
in the product currently uses it.

---

## 3. Findings

Severity reflects engineering risk. IDs match `tools/privacy-gate/privacy-policy.json`.

### P001 — World-readable renter identity and live location (resolved)

Firestore no longer permits public reads of boats or their history. Access now
requires a verified, active profile whose role and function level agree with
the Firebase token. Administrators, managers, and staff with Operations access
may read operational boat data; volunteers and unauthenticated users cannot.
Rules emulator tests and the privacy gate block restoration of unconditional
public reads.

### P002 — Retained log allowlist (currently passing)

`rental_history` is constrained by `hasOnly()` to pseudonymous operational fields, and
updates/deletes are denied. This is good design and the gate now guards it
against regression.

### P003 — Server-side tracking gate (currently passing)

`cloud-ingest/index.js` writes a breadcrumb only when `tracking_enabled` is
true. Enforcing this server-side rather than in the browser is correct.

### P004 — Erasure at check-in (currently passing)

The MFA-protected `checkInBoat` callable disables tracking and clears renter
identity and latest coordinates in a server-side transaction, then recursively
deletes the trail before reporting success. Disabling tracking first prevents
new breadcrumbs during deletion, and repeated check-in calls retry cleanup.

### P005 — Overstated anonymisation claim (fixed in this change)

The history page described the log as "Anonymised". It retains `device_id` and
exact timestamps, so it is **pseudonymous** — cross-referencing a paper waiver
or booking record re-identifies the renter. It does not meet the
RCW 19.373.010(10) deidentification standard, which additionally requires a
public commitment not to re-identify and contractual obligations on recipients.

Overstating erasure is an FTC Act s5 deception risk and, via RCW 19.373.090, a
per se CPA violation. Wording is now precise; the gate blocks recurrence.

### P006 — Unbounded trail retention (resolved)

Check-in remains the primary erasure event. As a backstop,
`purgeExpiredTrails` runs every six hours and deletes history older than 48
hours, independent of browser state or whether staff completed check-in.

### P007 — MEDIUM: no consent artifact

RCW 19.373.030(1)(c) requires consent **before** collection, disclosing the
categories collected, the purpose, recipients, and how to withdraw. It may not
be bundled into general terms (RCW 19.373.010(6)(b)).

The check-out dialog tells *staff* that tracking starts. Nothing records that
the *renter* was told or agreed. If MHMDA applies, this gap is squarely a
violation.

### P008 — MEDIUM: no privacy policy, no consumer rights mechanism

RCW 19.373.020(1)(b) requires a consumer health data privacy policy linked from
the homepage. RCW 19.373.040 requires mechanisms to confirm, access, withdraw
consent, and delete, with a 45-day response deadline and an appeal path. None
exist.

### Additional legal risk — no age gating (COPPA)

CWB runs youth programs. COPPA (16 CFR 312.2) treats geolocation identifying
street and town as personal information for children under 13, requiring
verifiable parental consent (16 CFR 312.5). The renter name field has no age
gate and no parental consent path. Penalties are assessed per violation.

### P009 — Staff account store access (currently passing)

The `users` collection is never public. A user may read only their own matching
profile; an MFA administrator may list accounts, and role writes occur only
through guarded Cloud Functions. Operations and Administration are separate
function levels, and administration links remain hidden from Operations users.

### Battery lifecycle records

Battery service events and completed cycle summaries are stored separately from
rental history and GPS trails. They contain no renter name, party size, or
coordinates. Override rationale is a controlled operational code rather than
free text. A red-battery override includes a one-way pseudonymous staff actor
identifier for accountability; this remains personal data, is deleted after
one year, and must not be described as anonymous.

### Additional hardware risk — local storage and thermal transition

The current 8x8 thermal array is unlikely to identify a specific individual,
but its body-heat measurement still strengthens the MHMDA applicability
question. The approved tracker revision removes the thermal array. MicroSD is
present in the target hardware but must not log renter-linked GPS until CWB has
approved a bounded retention, overwrite, access, and physical-recovery policy.

---

## 4. What the design already gets right

Worth preserving under change:

- Server-side purpose limitation on breadcrumb retention.
- A key allowlist on the retained log, enforced by rules rather than convention.
- Append-only retention log — no updates or deletes.
- Geofenced mooring classification, which avoids inferring behaviour off-dock.
- Erasure as an explicit, user-visible step with a plain-language dialog.

---

## 5. Priority

| Priority | Finding | Action |
| :--- | :--- | :--- |
| 1 | Section 2 | Get a written MHMDA applicability determination |
| 2 | P007, P008 | Consent artifact, privacy policy, consumer rights |
| 3 | COPPA risk | Decide whether minors can be renters; gate accordingly |
| 4 | Hardware transition | Remove thermal telemetry unless approved; define MicroSD retention before enabling local logs |

---

## 6. Enforcement

`tools/privacy-gate/privacy-gate.mjs` encodes the mechanically checkable rules
and runs before every firmware build, before the Firebase deploy task, and in
CI. Findings that cannot be fixed immediately are recorded in
`tools/privacy-gate/privacy-policy.json` with an owner and a `reviewBy` date;
**acknowledgements expire and the build fails once they do.**

The agent at `.github/agents/PrivacyChecker.agent.md` guides
review of new data flows, which no linter can assess.

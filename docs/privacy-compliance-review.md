# Privacy Compliance Review

**Scope:** CWB rowboat tracking system — firmware, ChirpStack ingest, GCP/Firestore
platform, operations dashboard, administration and rental history pages.
**Reviewed against:** Washington State and US federal privacy law.
**Date:** 2026-08-24

> **This is an engineering review, not legal advice.** It is written by the
> engineering team to identify risk and drive design decisions. Washington's My
> Health My Data Act carries a private right of action, so CWB should have
> counsel confirm the applicability question in Section 2 before go-live.

---

## 1. What the system actually collects

| Data | Where it lives | Linked to a person? |
| :--- | :--- | :--- |
| Renter full name (`booked_by`) | `boats/{DevEUI}` | Directly identifying |
| Precise GPS, ~15 min cadence | `boats/{DevEUI}/history`, `last_ping` | Yes, while checked out |
| Party size (`passenger_count`) | `boats/{DevEUI}`, `rental_history` | Indirectly |
| Max thermal pixel (`max_temperature_c`) | `last_ping`, trail entries | Body-heat derived |
| Mooring variance | `last_ping`, trail entries | Behavioural |
| Rental times | `rental_history` | Pseudonymous |

GPS resolution is far finer than the 1,750 ft threshold that makes location
"precise location information" under RCW 19.373.010(19).

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
2. **The AMG8833 thermal array measures body heat.** Under
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

**Engineering recommendation regardless of the answer:** stop storing
`max_temperature_c` unless there is a documented operational purpose. It is the
single field that most strongly pulls this system into MHMDA scope, and nothing
in the product currently uses it.

---

## 3. Findings

Severity reflects engineering risk. IDs match `tools/privacy-gate/privacy-policy.json`.

### P001 — CRITICAL: renter identity and live location are world-readable

`platforms/gcp/firestore.rules` grants `allow read: if true` on both
`/boats/{boatId}` and `/boats/{boatId}/history`. The boat document holds
`booked_by` (full name) alongside `last_ping` coordinates.

**Anyone on the internet who knows the Firebase project ID can read the name of
the person currently in a given boat and their live position, plus their full
route history.** The Firebase web API key is embedded in client JavaScript, as
it is designed to be — the rules are the only access control, and they permit
everything.

This is the most serious finding in the review. It implicates:

- **RCW 19.373.050(1)(a)** — access must be restricted to those for whom it is
  necessary. Unauthenticated public read is the opposite.
- **RCW 19.373.030(1)** — public exposure is "sharing" without consent.
- **FTC Act s5** — the product tells renters their data is protected.
- **RCW 19.255.010** — this may already constitute a reportable exposure.

Real-world harm is not abstract: a named individual's live position on open
water is a stalking and domestic-violence risk.

**Remediation.** Firestore has no field-level read control, so this cannot be
fixed by tweaking a condition. Split the data:

- Keep public: boat name, coordinates, mooring state, battery — no identity.
- Move to an admin-only collection: `booked_by`, `passenger_count`,
  and the rental linkage.
- Require authentication to read `boats/{id}/history`, or drop the public route
  trail entirely.

The dashboard already authenticates for check-in/check-out, so staff retain
access with no workflow change.

### P002 — Retained log allowlist (currently passing)

`rental_history` is constrained by `hasOnly()` to six non-identifying keys, and
updates/deletes are denied. This is good design and the gate now guards it
against regression.

### P003 — Server-side tracking gate (currently passing)

`cloud-ingest/index.js` writes a breadcrumb only when `tracking_enabled` is
true. Enforcing this server-side rather than in the browser is correct.

### P004 — Erasure at check-in (currently passing, with a caveat)

Check-in deletes the trail and clears identity. **Caveat:** deletion runs as a
client-side loop in `dashboard.js`. If the browser is closed mid-operation, the
trail partially survives while the UI has already reported erasure. Under
RCW 19.373.040(1)(c) the deletion duty is absolute. Move this to a callable
Cloud Function so it is atomic and auditable.

### P005 — Overstated anonymisation claim (fixed in this change)

The history page described the log as "Anonymised". It retains `device_id` and
exact timestamps, so it is **pseudonymous** — cross-referencing a paper waiver
or booking record re-identifies the renter. It does not meet the
RCW 19.373.010(10) deidentification standard, which additionally requires a
public commitment not to re-identify and contractual obligations on recipients.

Overstating erasure is an FTC Act s5 deception risk and, via RCW 19.373.090, a
per se CPA violation. Wording is now precise; the gate blocks recurrence.

### P006 — MEDIUM: unbounded retention when a rental is never closed

Erasure is triggered only by check-in. A boat that is never checked in — staff
forget, browser closes, hardware fails — retains its trail indefinitely. The
Wix variant prunes at 30 days; GCP has no equivalent. Contrast
RCW 19.373.030(1)(a)(ii), which permits collection only to the extent necessary.

**Remediation.** Scheduled purge deleting trails older than the maximum rental
window, independent of check-in.

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

### P009 — MEDIUM: no age gating (COPPA)

CWB runs youth programs. COPPA (16 CFR 312.2) treats geolocation identifying
street and town as personal information for children under 13, requiring
verifiable parental consent (16 CFR 312.5). The renter name field has no age
gate and no parental consent path. Penalties are assessed per violation.

### P010 — LOW: excessive privilege for dock staff

Check-in/check-out requires the `admin` custom claim — the same claim that
authorises fleet reconfiguration. RCW 19.373.050(1)(a) calls for access limited
to what is necessary. Split into a `staff` claim for rentals and reserve `admin`
for configuration.

### P011 — LOW: biometric analysis is resolution-dependent

An 8x8 thermal array cannot identify a specific individual, so it is very likely
outside RCW 19.375 (which also excludes photographs and video). This conclusion
**depends on the sensor's resolution**. The MLX90621 evaluation part is 16x4;
materially higher resolution would require re-analysis.

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
| 1 | P001 | Split identity from the public document; authenticate trail reads |
| 2 | Section 2 | Get a written MHMDA applicability determination |
| 3 | P007, P008 | Consent artifact, privacy policy, consumer rights |
| 4 | P009 | Decide whether minors can be renters; gate accordingly |
| 5 | P004, P006 | Server-side atomic erasure plus a scheduled purge |
| 6 | P010, thermal | Split the staff claim; drop `max_temperature_c` |

---

## 6. Enforcement

`tools/privacy-gate/privacy-gate.mjs` encodes the mechanically checkable rules
and runs before every firmware build, before the Firebase deploy task, and in
CI. Findings that cannot be fixed immediately are recorded in
`tools/privacy-gate/privacy-policy.json` with an owner and a `reviewBy` date;
**acknowledgements expire and the build fails once they do.**

The agent at `.github/agents/PrivacyChecker.agent.md` guides
review of new data flows, which no linter can assess.

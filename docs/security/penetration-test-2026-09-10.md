# Production Web Penetration Test - 2026-09-10

## Scope

- `https://cwb-boat-operations-c50dd.web.app`
- Unauthenticated browser behavior and Firebase Google sign-in bootstrap
- Non-destructive testing only; no credential guessing, data mutation, persistence, or denial-of-service activity

## Finding PT-001: Firebase Authentication Blocked By CSP

**Severity:** High availability and access-control failure

The production Content Security Policy allowed `www.gstatic.com` and Google reCAPTCHA origins but did not allow `https://apis.google.com`. Firebase Auth loads `api.js` from that origin for Google popup authentication. The browser blocked the script and Firebase returned `auth/internal-error`, preventing every authorized user from signing in.

Evidence before remediation:

- Browser CSP violation for `https://apis.google.com/js/api.js`
- Failed request reason `csp`
- Firebase console error `auth/internal-error`
- No provider popup or Firebase Auth iframe

Remediation:

- Added only `https://apis.google.com` to `script-src` in `platforms/gcp/firebase.json`
- Added a blocking assertion to `tools/security-gate/security-gate.mjs`
- Deployed Firebase Hosting only; no data or Function changes were required

Verification after remediation:

- Uncached production response contains the corrected CSP
- No CSP violation or `auth/internal-error` occurs after selecting Sign In
- Firebase Auth iframe loads from `cwb-boat-operations-c50dd.firebaseapp.com`
- reCAPTCHA Enterprise iframe loads from `www.google.com`

## Residual Notes

The browser may log `Cross-Origin-Opener-Policy policy would block the window.closed call` while Firebase polls the Google popup. The site already uses `same-origin-allow-popups`; this diagnostic did not prevent the Firebase Auth iframe or provider flow from loading.

Completing authentication with a real user, MFA challenge, and role authorization was outside this unauthenticated test because credentials were not supplied through the test channel.

## Resumed Test Findings

### PT-002: TOTP Seed Sent To Third-Party QR Service

**Severity:** High

MFA enrollment embedded the complete `otpauth://` URI in a request to `api.qrserver.com`. That URI contains the long-lived TOTP seed. A third party or its logs could therefore reproduce the second factor.

Remediation and verification:

- Vendored the MIT-licensed `qrcode-generator` browser build at an exact package version.
- QR images are generated as local data URLs; no enrollment secret leaves the browser.
- Removed `api.qrserver.com` from CSP and added a blocking security-gate assertion.

### PT-003: Unpinned Executable CDN Assets

**Severity:** High

The rental simulation executed Leaflet and Lucide from `unpkg.com` without Subresource Integrity. Compromise of that delivery path would execute code in the CWB origin.

Remediation and verification:

- Replaced CDN scripts and styles with the existing same-origin vendored assets.
- Removed `unpkg.com` from CSP and removed Google Fonts requests from the simulation.
- The security gate now rejects those third-party origins.

### PT-004: Volunteer Access To Sensitive Boat Documents

**Severity:** High

Firestore Rules allowed volunteer accounts to retrieve complete boat and history documents. Hiding renter names in the UI did not prevent direct access to renter identity and precise location.

Remediation and verification:

- Removed volunteers from sensitive operational reads in Firestore Rules and the live dashboard authorization specification.
- Firestore emulator tests prove volunteer boat and history reads fail while manager/staff reads continue to succeed.

### PT-005: Staff Roster Cached After Sign-Out

**Severity:** Medium

The Account Administration page cached the staff roster, including email and address data, in `sessionStorage`.

Remediation and verification:

- Removed roster persistence and clear in-memory roster state on sign-out.
- Added a security-gate assertion rejecting roster use of `sessionStorage`.

### PT-006: Simulation HTML Injection

**Severity:** Low

Simulation renter input reached HTML-rendering sinks. CSP limited ordinary script execution, but markup injection and UI spoofing remained possible.

Remediation and verification:

- Escaped renter names, phone values, activity messages, toast text, and displayed boat text before HTML rendering.
- Focused Snyk Code scan reported no remaining finding.

### PT-007: Internal Gateway Error Disclosure

**Severity:** Low

Authenticated administrators could receive raw fetch errors and upstream ChirpStack response text.

Remediation and verification:

- Client responses are fixed messages; server logs contain only an error name or HTTP status.
- Unit tests verify the fixed client errors contain no URL, token, environment, stack, or upstream response detail.

### PT-008: Unknown Paths Returned Dashboard With HTTP 200

**Severity:** Low

Hosting rewrote secret-like and unknown paths such as `/.env`, `/.git/config`, and `/404-does-not-exist` to the dashboard with status 200. No file content was disclosed, but this masked routing mistakes and produced misleading scanner results.

Remediation and verification:

- Removed the catch-all SPA rewrite and added a same-origin 404 page.
- Static responses use `Cache-Control: no-store, max-age=0` so security fixes do not remain stale.

### PT-009: Stale ID-Token Claims Retained Firestore Access

**Severity:** High

Firestore authorization trusted role claims embedded in ID tokens. Disabling an account, revoking refresh tokens, or demoting a user does not invalidate an already-issued token immediately, so direct Firestore access could continue until token expiry.

Remediation and verification:

- Sensitive Firestore authorization now reads `status`, `role`, and `functionLevel` from the live `users/{uid}` profile on each request.
- TOTP presence remains bound to the verified Firebase token.
- Emulator tests prove suspended and demoted profiles are denied even when requests carry stale staff or administrator claims.
- Production profile readiness was checked by aggregate counts only before deployment; no identity or profile data was printed.

### PT-010: Protected Content Visible Before Authentication Resolved

**Severity:** Medium

Protected HTML rendered before the asynchronous Firebase authorization callback displayed the sign-in modal. A signed-out visitor could briefly see page structure or stale browser-rendered content.

Remediation and verification:

- Protected documents carry an `auth-pending` marker from the first HTML parse and load a render-blocking same-origin stylesheet.
- All body content except the auth modal remains hidden while signed out, denied, or pending.
- The shared guard reveals content only after authorization succeeds; the MFA page reveals only after its Firebase state resolves.
- The penetration gate verifies every protected page and the authorized reveal path.
- With the Firebase Auth module deliberately delayed by 2.5 seconds, the history application container remained `visibility:hidden`; after signed-out resolution, it remained hidden while only the sign-in modal became visible.
- The MFA page removed `auth-pending` only after Firebase resolved and displayed its safe signed-out state.

## Black-Box Boundary Results

- Telemetry endpoint: GET and OPTIONS returned 405; POST without token returned 403; wrong content type returned 415.
- Firestore unauthenticated read returned 403 and disclosed no document.
- Callable request without a valid Firebase callable envelope/authentication did not execute application behavior.
- Secret-like Hosting paths returned only the pre-remediation SPA document; no environment, Git, rules, package, or server-status content was disclosed.
- TLS was provided by Firebase Hosting and all tested pages retained CSP, HSTS, framing, MIME-sniffing, referrer, permissions, and COOP headers.
- TLS 1.2 completed with certificate verification; a forced TLS 1.0 connection was rejected.

## Test Limitations

This was a bounded, non-destructive assessment. It did not include credential guessing, authenticated role testing with real users, destructive writes, persistence, high-volume rate-limit testing, Cloud Armor bypass testing, social engineering, or third-party infrastructure testing. Firestore role behavior was tested with the local emulator instead of production data.

The instrumented browser was rejected by reCAPTCHA Enterprise and blocked popup creation, so it could not complete a real Google sign-in or MFA challenge. It did verify that Firebase no longer reports `auth/internal-error` or a CWB CSP violation and that the Firebase Auth bootstrap is present.

## Static Analysis Disposition

- Focused Snyk Code scans of MFA, simulation, account administration, and boat configuration found no issues after remediation.
- A broad frontend scan identified DOM-XSS alerts around Fleet Administration rendering. Dynamic options, rows, controls, and schedule inputs were rebuilt with DOM APIs, `textContent`, and element properties rather than `innerHTML`; focused rescanning then reported zero findings.
- The Firebase web API key is intentionally public client configuration, not an authorization secret. Access control remains in Auth, App Check, callable guards, and Firestore Rules. Secret scanning remains strict for actual credentials.
- VS Code continued to display a stale exception-to-DOM warning at a `document.createElement` line after exception data and the HTML sink were removed. Direct Snyk scan and source inspection found no source-to-sink flow.
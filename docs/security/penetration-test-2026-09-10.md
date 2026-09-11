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
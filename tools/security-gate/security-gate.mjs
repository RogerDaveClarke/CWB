#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const POLICY_PATH = join(HERE, 'gcp-endpoints.json');
const ASSURANCE_PATH = join(HERE, 'security-assurance.json');
const FUNCTIONS_DIR = join(ROOT, 'platforms', 'gcp', 'cloud-ingest');
const ENTRYPOINT_PATH = join(FUNCTIONS_DIR, 'index.js');
const failures = [];

function read(relativePath) {
  const path = join(ROOT, relativePath);
  if (!existsSync(path)) {
    failures.push(`Missing required file: ${relativePath}`);
    return '';
  }
  return readFileSync(path, 'utf8');
}

function listJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listJavaScriptFiles(path);
    return entry.isFile() && /\.js$/.test(entry.name) ? [path] : [];
  });
}

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function hasGuardCall(source, guard) {
  const escapedGuard = guard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*(?:const\\s+\\w+\\s*=\\s*)?(?:await\\s+)?${escapedGuard}\\s*;\\s*$`, 'm')
    .test(withoutComments(source));
}

const policy = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
const assurance = JSON.parse(readFileSync(ASSURANCE_PATH, 'utf8'));
const today = new Date().toISOString().slice(0, 10);
if (!assurance.owner || assurance.nextReviewBy < today) failures.push('Security assurance review is missing an owner or overdue.');
for (const document of assurance.requiredDocuments || []) read(document);
for (const risk of assurance.acceptedRisks || []) {
  if (!risk.id || !risk.owner || !risk.reason || !risk.compensatingControl || !risk.reviewBy) failures.push('Accepted security risk is missing required metadata.');
  else if (risk.reviewBy < today) failures.push(`Accepted security risk ${risk.id} is overdue for review.`);
}
const expected = new Map(policy.endpoints.map((endpoint) => [endpoint.name, endpoint]));
if (expected.size !== policy.endpoints.length) failures.push('Endpoint policy contains duplicate names.');

const discovered = new Map();
const declaration = /exports\.(\w+)\s*=\s*(onCall|onRequest|onSchedule)\s*\(/g;
for (const absolutePath of listJavaScriptFiles(FUNCTIONS_DIR)) {
  const source = readFileSync(absolutePath, 'utf8');
  const matches = [...source.matchAll(declaration)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const name = match[1];
    const endpoint = {
      name,
      trigger: match[2],
      file: relative(ROOT, absolutePath).replaceAll('\\', '/'),
      implementation: source.slice(match.index, matches[index + 1]?.index ?? source.length)
    };
    if (discovered.has(name)) failures.push(`Duplicate exported endpoint: ${name}`);
    discovered.set(name, endpoint);
  }
}

const entrypointSource = readFileSync(ENTRYPOINT_PATH, 'utf8');
const imports = new Map(
  [...entrypointSource.matchAll(/const\s+(\w+)\s*=\s*require\(['"](\.\/.+?)['"]\)\s*;/g)]
    .map((match) => [match[1], `${match[2].replace(/^\.\//, '')}.js`])
);
const exported = new Map();
for (const match of entrypointSource.matchAll(/exports\.(\w+)\s*=\s*([^;\r\n]+)/g)) {
  const [assignment, name, expression] = match;
  if (/^on(?:Call|Request|Schedule)\s*\(/.test(expression)) {
    exported.set(name, discovered.get(name));
    continue;
  }

  const alias = expression.trim().match(/^(\w+)\.(\w+)$/);
  const importedFile = alias && imports.get(alias[1]);
  const endpoint = alias && discovered.get(alias[2]);
  if (!endpoint || endpoint.file !== `platforms/gcp/cloud-ingest/${importedFile}`) {
    failures.push(`Unresolved GCP entrypoint export: ${assignment.trim()}`);
    continue;
  }
  exported.set(name, { ...endpoint, name });
}

for (const [name, endpoint] of exported) {
  if (!endpoint) {
    failures.push(`Unresolved GCP entrypoint export: ${name}`);
    continue;
  }
  const rule = expected.get(name);
  if (!rule) {
    failures.push(`Unclassified GCP endpoint: ${endpoint.file} exports ${name}`);
    continue;
  }
  if (rule.file !== endpoint.file || rule.trigger !== endpoint.trigger) {
    failures.push(`${name} does not match its policy file or trigger.`);
  }
  if (rule.guard && !hasGuardCall(endpoint.implementation, rule.guard)) {
    failures.push(`${name} is missing required ${rule.authentication} guard: ${rule.guard}`);
  }
}

for (const name of expected.keys()) {
  if (!exported.has(name)) failures.push(`Policy endpoint is not exported: ${name}`);
}

for (const endpoint of exported.values()) {
  if (endpoint.trigger === 'onCall'
      && !endpoint.implementation.includes('CALLABLE_OPTIONS')
      && !endpoint.implementation.includes('enforceAppCheck: true')) {
    failures.push(`${endpoint.name} does not enforce Firebase App Check.`);
  }
}

const webhookSource = read('platforms/gcp/cloud-ingest/index.js');
for (const control of [
  "secrets: ['CHIRPSTACK_WEBHOOK_TOKEN']",
  'authenticateWebhookRequest(req, expectedToken)',
  'db.runTransaction',
  "db.collection('_ingest_receipts')"
]) {
  if (!webhookSource.includes(control)) failures.push(`telemetryIngest is missing control: ${control}`);
}

const webhookAuthSource = read('platforms/gcp/cloud-ingest/webhookAuth.js');
for (const control of ['timingSafeEqual', "request.method !== 'POST'", 'MAX_BODY_BYTES', 'withinRateLimit']) {
  if (!webhookAuthSource.includes(control)) failures.push(`Webhook authentication helper is missing control: ${control}`);
}

const callableAuthSource = read('platforms/gcp/cloud-ingest/authGuards.js');
for (const control of ['if (!request.auth)', "token.admin === true && token.role === 'admin'", 'function requireMfaOperations', "['manager', 'staff'].includes(token.role)", "sign_in_second_factor !== 'totp'"]) {
  if (!callableAuthSource.includes(control)) failures.push(`Callable authentication helper is missing control: ${control}`);
}

const userAdminOptionsSource = read('platforms/gcp/cloud-ingest/userAdmin.js');
for (const control of [
  'enforceAppCheck: true',
  "serviceAccount: 'cwb-user-admin@cwb-boat-operations-c50dd.iam.gserviceaccount.com'"
]) {
  if (!userAdminOptionsSource.includes(control)) failures.push(`User callable options are missing control: ${control}`);
}

const userAdminSource = read('platforms/gcp/cloud-ingest/userAdmin.js');
const checkInSource = userAdminSource.match(/exports\.checkInBoat\s*=\s*onCall\([\s\S]*$/)?.[0] || '';
for (const control of [
  'requireMfaOperations(request)',
  'db.runTransaction',
  'tracking_enabled: false',
  "db.recursiveDelete(boatRef.collection('history'))"
]) {
  if (!checkInSource.includes(control)) failures.push(`checkInBoat is missing lifecycle control: ${control}`);
}
const dashboardSource = read('platforms/gcp/frontend/dashboard.js');
if (!dashboardSource.includes('httpsCallable(functions, "checkInBoat")')) {
  failures.push('Dashboard check-in does not use the authenticated server-side lifecycle endpoint.');
}
if (/deleteDoc\([^)]*history/.test(dashboardSource) || /addDoc\([^)]*rental_history/.test(dashboardSource)) {
  failures.push('Dashboard performs a privileged rental lifecycle operation directly.');
}

const boatConfigSource = read('platforms/gcp/cloud-ingest/boatConfig.js');
for (const control of [
  'enforceAppCheck: true',
  "secrets: ['CHIRPSTACK_API_TOKEN']",
  "serviceAccount: 'cwb-boat-config@cwb-boat-operations-c50dd.iam.gserviceaccount.com'"
]) {
  if (!boatConfigSource.includes(control)) failures.push(`pushBoatConfig is missing control: ${control}`);
}
if (/error\.message|response\.text\(/.test(boatConfigSource)) {
  failures.push('pushBoatConfig reflects internal gateway errors to clients.');
}
if (!webhookSource.includes("serviceAccount: 'cwb-telemetry-ingest@cwb-boat-operations-c50dd.iam.gserviceaccount.com'")) {
  failures.push('telemetryIngest is missing its dedicated service account.');
}
const authGuardSource = read('platforms/gcp/frontend/auth-guard.js');
for (const control of ['initializeAppCheck', 'ReCaptchaEnterpriseProvider', 'isTokenAutoRefreshEnabled: true']) {
  if (!authGuardSource.includes(control)) failures.push(`Frontend App Check is missing control: ${control}`);
}

const firebaseConfig = read('platforms/gcp/firebase.json');
for (const header of [
  'Content-Security-Policy',
  'Strict-Transport-Security',
  'X-Content-Type-Options',
  'X-Frame-Options',
  'Referrer-Policy',
  'Permissions-Policy'
]) {
  if (!firebaseConfig.includes(`"key": "${header}"`)) failures.push(`Firebase Hosting is missing security header: ${header}`);
}
if (!firebaseConfig.includes("script-src 'self' https://www.gstatic.com https://apis.google.com")) {
  failures.push('Firebase Hosting CSP blocks the Google API script required by Firebase Auth.');
}
for (const forbiddenOrigin of ['https://unpkg.com', 'https://api.qrserver.com']) {
  if (firebaseConfig.includes(forbiddenOrigin)) failures.push(`Firebase Hosting trusts unnecessary third-party origin: ${forbiddenOrigin}`);
}
const mfaSource = read('platforms/gcp/frontend/mfa.js');
if (!mfaSource.includes('window.qrcode') || /qrserver\.com/.test(mfaSource)) {
  failures.push('MFA QR generation is not fully local.');
}
const simulationHtml = read('platforms/gcp/frontend/rental-simulation.html');
if (/https:\/\/unpkg\.com/.test(simulationHtml)) failures.push('Rental simulation executes CDN assets.');
if (/https:\/\/fonts\.(?:googleapis|gstatic)\.com/.test(simulationHtml)) failures.push('Rental simulation sends browser metadata to third-party font services.');
const usersSource = read('platforms/gcp/frontend/users.js');
if (/sessionStorage\.(?:getItem|setItem)\([^)]*roster/i.test(usersSource)) {
  failures.push('Account roster PII is cached in sessionStorage.');
}
if (firebaseConfig.includes('{ "source": "**", "destination": "/index.html" }')) {
  failures.push('Firebase Hosting masks unknown and sensitive-looking paths with a 200 SPA fallback.');
}
if (!firebaseConfig.includes('"value": "no-store, max-age=0"')) {
  failures.push('Firebase Hosting permits stale security-sensitive pages or assets.');
}

const retentionSource = read('platforms/gcp/cloud-ingest/retention.js');
for (const control of [
  'TRAIL_RETENTION_DAYS = 2',
  "schedule: 'every 6 hours'",
  "serviceAccount: 'cwb-telemetry-ingest@cwb-boat-operations-c50dd.iam.gserviceaccount.com'",
  "collectionGroup('history')",
  ".where('timestamp', '<', cutoff)"
]) {
  if (!retentionSource.includes(control)) failures.push(`Scheduled retention is missing control: ${control}`);
}

const reconciliationSource = read('platforms/gcp/cloud-ingest/identityReconciliation.js');
for (const control of [
  "schedule: 'every 1 hours'",
  "serviceAccount: 'cwb-user-admin@cwb-boat-operations-c50dd.iam.gserviceaccount.com'",
  "logSecurityEvent('identity_state_mismatch'"
]) {
  if (!reconciliationSource.includes(control)) failures.push(`Identity reconciliation is missing control: ${control}`);
}
if (!authGuardSource.includes('httpsCallable(functions, "reportSessionExit")')) {
  failures.push('Forced browser exits are not reported before local sign-out.');
}

const firestoreRules = read('platforms/gcp/firestore.rules');
if (/allow\s+(?:read|get|list)(?:\s*,\s*(?:read|get|list))*\s*:\s*if\s+true\s*;/.test(firestoreRules)) {
  failures.push('Firestore contains an anonymously readable collection.');
}
for (const control of [
  'function hasActiveProfile()',
  "get(/databases/$(database)/documents/users/$(request.auth.uid)).data.status == 'active'",
  "liveRole() == 'admin'",
  "request.auth.token.get('firebase', {}).get('sign_in_second_factor', '') == 'totp'",
  'function hasOperationsAccess()',
  'allow read: if hasOperationsAccess();'
]) {
  if (!firestoreRules.includes(control)) failures.push(`Firestore administrator guard is missing control: ${control}`);
}
if (/allow\s+read\s*:\s*if\s+isSignedIn\(\)\s*;/.test(firestoreRules)) {
  failures.push('Firestore operational data is readable by authenticated accounts without an assigned role.');
}
const operationsAccess = firestoreRules.match(/function hasOperationsAccess\(\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] || '';
if (/['"]volunteer['"]/.test(operationsAccess)) {
  failures.push('Volunteer accounts can retrieve documents containing renter identity or precise location.');
}

for (const workflow of ['.github/workflows/privacy-gate.yml', '.github/workflows/codeql.yml']) {
  const source = read(workflow);
  for (const match of source.matchAll(/uses:\s*([^\s#]+)/g)) {
    if (!/@[0-9a-f]{40}$/.test(match[1])) failures.push(`${workflow} uses an action without an immutable SHA: ${match[1]}`);
  }
}

const alertPolicy = read('platforms/gcp/security/security-alert-policy.json');
for (const metric of [
  'cwb_webhook_rejections',
  'cwb_callable_auth_denials',
  'cwb_unknown_devices',
  'cwb_retention_failures',
  'cwb_identity_state_mismatches',
  'cwb_forced_session_exits'
]) {
  if (!alertPolicy.includes(metric)) failures.push(`Security alert policy is missing metric: ${metric}`);
}
const controlAlertPolicy = read('platforms/gcp/security/control-change-alert-policy.json');
for (const control of ['conditionMatchedLog', 'SetIamPolicy', 'UpdateFunction', 'AddSecretVersion']) {
  if (!controlAlertPolicy.includes(control)) failures.push(`Control-change alert policy is missing: ${control}`);
}

console.log('GCP endpoint security gate');
console.log('='.repeat(72));
console.log(`${exported.size} endpoint(s) inventoried; ${failures.length} blocking finding(s).`);
for (const failure of failures) console.log(`[FAIL] ${failure}`);
if (!failures.length) console.log('All GCP endpoints have classified authentication controls.');

process.exit(failures.length ? 1 : 0);
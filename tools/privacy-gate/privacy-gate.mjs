#!/usr/bin/env node
// Deterministic privacy checks for the CWB tracker. Run by the default build task and CI.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const POLICY_PATH = join(HERE, "privacy-policy.json");
const JSON_OUTPUT = process.argv.includes("--json");

const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
const findings = [];

function read(relPath) {
    const full = join(ROOT, relPath);
    return existsSync(full) ? readFileSync(full, "utf8") : null;
}

function report(id, file, evidence) {
    const rule = policy.rules[id];
    if (!rule) throw new Error(`Unknown rule ${id}`);
    findings.push({ id, severity: rule.severity, title: rule.title, statutes: rule.statutes, remediation: rule.remediation, file, evidence });
}

// Associates every `allow` statement with the match path stack it sits inside.
function parseFirestoreRules(source) {
    const stack = [];
    const rules = [];
    for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim();
        const match = line.match(/^match\s+(\S+)\s*\{/);
        if (match) { stack.push(match[1]); continue; }
        const allow = line.match(/^allow\s+([a-z,\s]+):\s*if\s+(.+?);\s*$/);
        if (allow) {
            rules.push({
                path: stack.join(""),
                operations: allow[1].split(",").map(part => part.trim()).filter(Boolean),
                condition: allow[2].trim()
            });
            continue;
        }
        if (line.startsWith("}")) stack.pop();
    }
    return rules;
}

function checkFirestoreExposure() {
    const file = "platforms/gcp/firestore.rules";
    const source = read(file);
    if (!source) return;

    for (const rule of parseFirestoreRules(source)) {
        const isSensitive = policy.sensitivePathPatterns.some(pattern => new RegExp(pattern).test(rule.path));
        const isPublic = /^true$/.test(rule.condition);
        if (isSensitive && isPublic && rule.operations.some(op => op === "read" || op === "get" || op === "list")) {
            report("P001", file, `${rule.path} -> allow ${rule.operations.join(", ")}: if ${rule.condition};`);
        }
    }

    const allowlist = source.match(/rental_history[\s\S]*?hasOnly\(\[([\s\S]*?)\]\)/);
    if (allowlist) {
        const keys = [...allowlist[1].matchAll(/'([^']+)'/g)].map(entry => entry[1]);
        const banned = keys.filter(key => policy.identityKeys.includes(key) || policy.locationKeys.includes(key));
        if (banned.length) report("P002", file, `rental_history permits ${banned.join(", ")}`);
    }
}

function checkTrackingGate() {
    const file = "platforms/gcp/cloud-ingest/index.js";
    const source = read(file);
    if (!source) return;
    const writesTrail = /collection\(\s*['"]history['"]\s*\)\s*\.add\(/.test(source);
    const gated = /tracking_enabled/.test(source);
    if (writesTrail && !gated) report("P003", file, "history().add() is not gated on tracking_enabled");
}

function checkErasureOnCheckIn() {
    const file = "platforms/gcp/frontend/dashboard.js";
    const source = read(file);
    if (!source) return;
    const deletesTrail = /deleteDoc\(/.test(source) && /['"]history['"]/.test(source);
    const clearsIdentity = policy.identityKeys.some(key => new RegExp(`${key}:\\s*deleteField\\(\\)`).test(source));
    if (!deletesTrail) report("P004", file, "check-in does not delete the GPS trail");
    if (!clearsIdentity) report("P004", file, "check-in does not clear renter identity fields");
}

function checkAnonymisationClaims() {
    const source = read("platforms/gcp/frontend/dashboard.js") || "";
    const retainsPersistentId = /device_id:\s*boat\.id/.test(source);
    if (!retainsPersistentId) return;
    // "pseudonymous rather than anonymous" is an accurate disclaimer, not a claim.
    const negated = /(not|never|rather than|isn't|is not|non-)\s+$/i;
    for (const file of policy.claimSurfaces) {
        const text = read(file);
        if (!text) continue;
        for (const hit of text.matchAll(/\b(anonymised|anonymized|anonymous)\b/gi)) {
            if (negated.test(text.slice(Math.max(0, hit.index - 24), hit.index))) continue;
            const line = text.slice(0, hit.index).split(/\r?\n/).length;
            report("P005", `${file}:${line}`, text.slice(Math.max(0, hit.index - 40), hit.index + 40).replace(/\s+/g, " ").trim());
        }
    }
}

function checkRetentionLimit() {
    const configured = policy.retention.gcpTrailMaxDays !== null;
    const hasScheduledPurge = Boolean(read(policy.retention.gcpPurgeImplementation));
    if (!configured || !hasScheduledPurge) {
        report("P006", "platforms/gcp/", "no scheduled purge bounds GPS trail retention if a check-in never happens");
    }
}

function checkConsentArtifact() {
    const file = "platforms/gcp/frontend/dashboard.js";
    const source = read(file);
    if (!source) return;
    if (!/consent/i.test(source)) report("P007", file, "check-out records no consent artifact");
}

function checkPrivacyPolicyLink() {
    const file = "platforms/gcp/frontend/index.html";
    const source = read(file);
    if (!source) return;
    if (!/privacy/i.test(source)) report("P008", file, "no privacy policy link on the operations homepage");
}

checkFirestoreExposure();
checkTrackingGate();
checkErasureOnCheckIn();
checkAnonymisationClaims();
checkRetentionLimit();
checkConsentArtifact();
checkPrivacyPolicyLink();

const today = new Date().toISOString().slice(0, 10);
const acknowledged = new Map(policy.acknowledged.map(entry => [entry.id, entry]));
let blocking = 0;
let expired = 0;

for (const finding of findings) {
    const ack = acknowledged.get(finding.id);
    if (!ack) { finding.state = finding.severity === "error" ? "BLOCKING" : "WARN"; }
    else if (ack.reviewBy < today) { finding.state = "EXPIRED"; expired += 1; }
    else { finding.state = "ACKNOWLEDGED"; finding.ack = ack; }
    if (finding.state === "BLOCKING" || finding.state === "EXPIRED") blocking += 1;
}

if (JSON_OUTPUT) {
    console.log(JSON.stringify({ generated: today, findings }, null, 2));
} else {
    const icon = { BLOCKING: "FAIL", EXPIRED: "EXPIRED", ACKNOWLEDGED: "ack ", WARN: "warn" };
    console.log("Privacy compliance gate");
    console.log("=".repeat(72));
    if (!findings.length) console.log("No findings.");
    for (const finding of findings) {
        console.log(`[${icon[finding.state]}] ${finding.id} ${finding.title}`);
        console.log(`         where: ${relative(".", finding.file)}`);
        console.log(`      evidence: ${finding.evidence}`);
        console.log(`      statutes: ${finding.statutes.join("; ")}`);
        console.log(`   remediation: ${finding.remediation}`);
        if (finding.ack) console.log(`  acknowledged: ${finding.ack.owner}, review by ${finding.ack.reviewBy} — ${finding.ack.reason}`);
        console.log("");
    }
    console.log("=".repeat(72));
    console.log(`${findings.length} finding(s); ${blocking} blocking; ${expired} expired acknowledgement(s).`);
    console.log("Report: docs/privacy-compliance-review.md");
    if (blocking) console.log("Build blocked. Resolve the finding or record a reviewed acknowledgement in tools/privacy-gate/privacy-policy.json.");
}

process.exit(blocking ? 1 : 0);

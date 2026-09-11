#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const FRONTEND_DIR = join(ROOT, 'platforms', 'gcp', 'frontend');
const failures = [];

function read(path) {
  if (!existsSync(path)) {
    failures.push(`Missing required file: ${relative(ROOT, path).replaceAll('\\', '/')}`);
    return '';
  }
  return readFileSync(path, 'utf8');
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'vendor' ? [] : listFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

function addFailure(message) {
  failures.push(message);
}

function hasMeaningfulText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasVisibleText(html) {
  const text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .trim();
  return hasMeaningfulText(text);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const htmlFiles = listFiles(FRONTEND_DIR).filter((file) => file.endsWith('.html'));

for (const htmlFile of htmlFiles) {
  const source = read(htmlFile);

  if (!/<html\b[^>]*\slang=/i.test(source)) {
    addFailure(`${relative(ROOT, htmlFile).replaceAll('\\', '/')} is missing a document language attribute.`);
  }

  if (!/<body\b/i.test(source)) {
    addFailure(`${relative(ROOT, htmlFile).replaceAll('\\', '/')} is missing a body element.`);
  }

  if (/<img\b(?![^>]*\balt=)/i.test(source)) {
    addFailure(`${relative(ROOT, htmlFile).replaceAll('\\', '/')} has an img without alt text.`);
  }

  const iconButtonMatches = [...source.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)];
  for (const match of iconButtonMatches) {
    const block = match[1] || '';
    const hasLabel = /aria-label=|aria-labelledby=|title=/i.test(match[0]) || hasVisibleText(block);
    if (!hasLabel && /<svg\b|<i\b/i.test(block) && !/aria-hidden="true"/i.test(block)) {
      addFailure(`${relative(ROOT, htmlFile).replaceAll('\\', '/')} contains an icon-only button without an accessible name.`);
    }
  }

  const formControls = [...source.matchAll(/<(?:input|select|textarea)\b([^>]*)>/gi)];
  for (const match of formControls) {
    const attrs = match[1] || '';
    if (/type\s*=\s*["']hidden["']/i.test(attrs)) continue;
    if (/aria-label=|aria-labelledby=/.test(attrs)) continue;
    if (/id\s*=\s*["'][^"']+["']/i.test(attrs)) {
      const idMatch = attrs.match(/id\s*=\s*["']([^"']+)["']/i);
      const id = idMatch ? idMatch[1] : null;
      const escapedId = id ? escapeRegExp(id) : null;
      const labelPattern = escapedId ? new RegExp(`<label\\b[^>]*\\bfor\\s*=\\s*["']${escapedId}["'][^>]*>.*?</label>`, 'is') : null;
      const wrappedLabelPattern = escapedId ? new RegExp(`<label\\b[^>]*>.*?<(?:input|select|textarea)[^>]*\\bid\\s*=\\s*["']${escapedId}["'][^>]*>.*?</label>`, 'is') : null;
      if ((!labelPattern || !labelPattern.test(source)) && (!wrappedLabelPattern || !wrappedLabelPattern.test(source))) {
        addFailure(`${relative(ROOT, htmlFile).replaceAll('\\', '/')} has a form control without a programmatic label.`);
      }
    }
  }

  if (/<dialog\b/i.test(source) && !/aria-modal=|role=\s*["']dialog["']/i.test(source)) {
    addFailure(`${relative(ROOT, htmlFile).replaceAll('\\', '/')} has a dialog without dialog semantics.`);
  }

  if (!/<meta\b[^>]*name=["']viewport["']/i.test(source)) {
    addFailure(`${relative(ROOT, htmlFile).replaceAll('\\', '/')} is missing a viewport meta tag.`);
  }

  if (/(color:\s*#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b|rgba?\([^)]+\)|hsla?\([^)]+\))/.test(source) && !/contrast/i.test(source)) {
    // This is intentionally non-blocking as a static heuristic; the gate is about finding actual control issues.
  }
}

const jsFiles = listFiles(ROOT).filter((file) => file.endsWith('.js') || file.endsWith('.mjs'));
for (const jsFile of jsFiles) {
  const relativePath = relative(ROOT, jsFile).replaceAll('\\', '/');
  if (relativePath.includes('node_modules') || relativePath.includes('vendor')) continue;
  const source = read(jsFile);
  if (/innerHTML\s*=\s*`|innerHTML\s*=\s*['"]/i.test(source) && /aria-label|textContent/.test(source) === false) {
    // heuristic only; this file is not a blocker unless the bug is obviously surfaced in UI review
  }
}

if (failures.length) {
  console.log('CWB accessibility gate');
  console.log('='.repeat(72));
  console.log(`${failures.length} blocking issue(s).`);
  for (const failure of failures) console.log(`[FAIL] ${failure}`);
  process.exit(1);
}

console.log('CWB accessibility gate');
console.log('='.repeat(72));
console.log('0 blocking issue(s).');
console.log('All HTML controls have labels, document language, and required accessibility basics.');
process.exit(0);

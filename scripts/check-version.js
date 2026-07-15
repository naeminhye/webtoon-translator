#!/usr/bin/env node
/**
 * Fails if package.json, extension/manifest.json, and the version mentioned
 * in docs/privacy-policy.html ever drift apart. The privacy policy
 * line is free text (not read from anywhere), so nothing else catches this —
 * run `npm run check:version` after bumping the version, or wire it into CI.
 */
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const pkg      = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension/manifest.json'), 'utf8'));

const privacyPath = path.join(ROOT, 'docs/privacy-policy.html');
const privacyHtml = fs.readFileSync(privacyPath, 'utf8');
const privacyMatch = privacyHtml.match(/applies to version ([\d.]+) and later/);

if (!privacyMatch) {
  console.error(
    `${path.relative(ROOT, privacyPath)}: could not find a version string ` +
    `(expected the text "applies to version X.Y.Z and later").`
  );
  process.exit(1);
}

const versions = {
  'package.json':             pkg.version,
  'extension/manifest.json':  manifest.version,
  'docs/privacy-policy.html': privacyMatch[1],
};

const distinct = new Set(Object.values(versions));

if (distinct.size > 1) {
  console.error('Version mismatch:');
  for (const [file, version] of Object.entries(versions)) {
    console.error(`  ${version.padEnd(10)} ${file}`);
  }
  console.error(
    '\nUpdate package.json, extension/manifest.json, and the ' +
    '"applies to version …" line in docs/privacy-policy.html so ' +
    'they all match, then re-run this check.'
  );
  process.exit(1);
}

console.log(`Versions match: ${[...distinct][0]}`);

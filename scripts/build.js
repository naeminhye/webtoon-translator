#!/usr/bin/env node
/**
 * Production build: copies extension/ -> dist/, flips the __DEV_TOOLS__ flag
 * to false, and strips every __DEV_TOOLS_BLOCK_START__..__DEV_TOOLS_BLOCK_END__
 * region (dev-only inspection tooling, e.g. the Translation List side panel)
 * out of the shipped files entirely.
 *
 * There's no bundler in this project (bundle.js is hand-authored, not
 * assembled by a tool) — this script is a plain source copy + string strip,
 * not a real dead-code-eliminating build.
 */
const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..');
const SRC_DIR   = path.join(ROOT, 'extension');
const DIST_DIR  = path.join(ROOT, 'dist');

const START_MARKER = '__DEV_TOOLS_BLOCK_START__';
const END_MARKER   = '__DEV_TOOLS_BLOCK_END__';
const STRIPPABLE_EXT = new Set(['.js', '.css', '.html']);

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function stripDevToolsBlocks(text, filePath) {
  const lines = text.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (!skipping && line.includes(START_MARKER)) { skipping = true; continue; }
    if (skipping) {
      if (line.includes(END_MARKER)) skipping = false;
      continue;
    }
    out.push(line);
  }
  if (skipping) {
    throw new Error(`${filePath}: found ${START_MARKER} with no matching ${END_MARKER}`);
  }
  return out.join('\n');
}

function processFile(filePath) {
  const ext = path.extname(filePath);
  if (!STRIPPABLE_EXT.has(ext)) return;

  let text = fs.readFileSync(filePath, 'utf8');
  text = text.replace(
    /const __DEV_TOOLS__ = true;/g,
    'const __DEV_TOOLS__ = false;'
  );
  text = stripDevToolsBlocks(text, filePath);
  fs.writeFileSync(filePath, text);
}

function walk(dir, fn) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, fn);
    else fn(p);
  }
}

rmrf(DIST_DIR);
copyDir(SRC_DIR, DIST_DIR);
walk(DIST_DIR, processFile);

console.log(`Production build written to ${path.relative(ROOT, DIST_DIR)}/ (__DEV_TOOLS__ = false, dev-only blocks stripped).`);

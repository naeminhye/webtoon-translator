#!/usr/bin/env node
/**
 * There's no dev server for this extension — source files under extension/
 * already ship with __DEV_TOOLS__ = true, so they can be loaded unpacked
 * as-is. This script just prints the reminder so `npm run dev` does
 * something sensible.
 */
console.log(
  'Dev mode: load extension/ directly as an unpacked extension\n' +
  '(chrome://extensions -> Load unpacked -> select the "extension" folder).\n' +
  '__DEV_TOOLS__ is already true in these source files, so the Translation\n' +
  'List side panel is available. Run `npm run build` to produce a dist/\n' +
  'folder with dev-only tooling stripped for production packaging.'
);

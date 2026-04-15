#!/usr/bin/env node
// bundle-smoke-test.mjs — D-03 verification: dist/index.js must load without unresolved imports.
// Run after `pnpm -w build`. Part of `pnpm verify` chain.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const distPath = resolve(__filename, '../../dist/index.js');

if (!existsSync(distPath)) {
  console.error(`[bundle-smoke] FAIL: dist/index.js not found at ${distPath}`);
  console.error('[bundle-smoke] Run `pnpm -w build` first.');
  process.exit(1);
}

try {
  await import(pathToFileURL(distPath).href);
  console.log('[bundle-smoke] dist/index.js loads');
  process.exit(0);
} catch (err) {
  console.error('[bundle-smoke] FAIL: dist/index.js threw during import:');
  console.error(err);
  process.exit(1);
}

#!/usr/bin/env node
// bundle-smoke-test.mjs — D-03 verification: dist/index.js must load without unresolved imports.
// Run after `pnpm -w build`. Part of `pnpm verify` chain.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const distPath = resolve(__filename, '../../dist/index.js');

if (!existsSync(distPath)) {
  console.error(`[bundle-smoke] FAIL: dist/index.js not found at ${distPath}`);
  console.error('[bundle-smoke] Run `pnpm -w build` first.');
  process.exit(1);
}

const result = spawnSync(process.execPath, [distPath, '--help'], {
  encoding: 'utf8',
  timeout: 10_000,
});

if (result.error) {
  console.error('[bundle-smoke] FAIL: dist/index.js failed to spawn:');
  console.error(result.error);
  process.exit(1);
}

if (result.status !== 0) {
  const reason =
    result.signal !== null
      ? `terminated by signal ${result.signal}`
      : `exited with code ${result.status}`;
  console.error(`[bundle-smoke] FAIL: dist/index.js --help ${reason}`);
  if (result.stdout) console.error(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(1);
}

console.log('[bundle-smoke] dist/index.js --help exited 0 — bundle OK');
process.exit(0);

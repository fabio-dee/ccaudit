#!/usr/bin/env node
// bundle-size-check.mjs — D-04 verification: dist/index.js gzipped size must not exceed
// bundle-baseline.txt by more than the configured budget. Uses node:fs + node:zlib only.
// Run after `pnpm -w build`. Part of `pnpm verify` chain.
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = resolve(__filename, '..');
const distPath = resolve(scriptsDir, '../dist/index.js');
const baselinePath = resolve(scriptsDir, 'bundle-baseline.txt');
const BUDGET_BYTES = 15 * 1024; // 15360 bytes per D-04

if (!existsSync(distPath)) {
  console.error(`[bundle-size] FAIL: dist/index.js not found at ${distPath}`);
  console.error('[bundle-size] Run `pnpm -w build` first.');
  process.exit(1);
}

if (!existsSync(baselinePath)) {
  console.error(`[bundle-size] FAIL: baseline file not found at ${baselinePath}`);
  process.exit(1);
}

const buf = readFileSync(distPath);
const gzipped = gzipSync(buf, { level: 9 });
const actual = gzipped.length;

const baselineRaw = readFileSync(baselinePath, 'utf8').trim();
const baseline = Number.parseInt(baselineRaw, 10);

if (!Number.isFinite(baseline) || baseline <= 0) {
  console.error(
    `[bundle-size] FAIL: could not parse baseline from ${baselinePath}: ${JSON.stringify(baselineRaw)}`,
  );
  process.exit(1);
}

const delta = actual - baseline;
console.log(
  `[bundle-size] actual=${actual}B baseline=${baseline}B delta=${delta}B budget=${BUDGET_BYTES}B`,
);

if (delta > BUDGET_BYTES) {
  console.error(`[bundle-size] FAIL: delta exceeds 15 KB budget (${delta} > ${BUDGET_BYTES})`);
  process.exit(1);
}

// Phase-local bundle gate (opt-in via CCAUDIT_PHASE_BASELINE=/path/to/baseline.txt env var).
// Phase 3.1 uses a <10 KB growth budget (D3.1-16); callers can override via CCAUDIT_PHASE_BUDGET_BYTES.
// Future phases can set their own baseline file + budget without touching this script.
const phaseBaselinePath = process.env.CCAUDIT_PHASE_BASELINE;
if (phaseBaselinePath) {
  if (!existsSync(phaseBaselinePath)) {
    console.error(
      `[bundle-size] FAIL: CCAUDIT_PHASE_BASELINE set but file not found at ${phaseBaselinePath}`,
    );
    process.exit(1);
  }
  const phaseBaselineRaw = readFileSync(phaseBaselinePath, 'utf8').trim();
  const phaseBaseline = Number.parseInt(phaseBaselineRaw, 10);
  if (!Number.isFinite(phaseBaseline) || phaseBaseline <= 0) {
    console.error(
      `[bundle-size] FAIL: could not parse phase baseline from ${phaseBaselinePath}: ${JSON.stringify(phaseBaselineRaw)}`,
    );
    process.exit(1);
  }
  const phaseBudgetRaw = process.env.CCAUDIT_PHASE_BUDGET_BYTES ?? '10240';
  const phaseBudget = Number.parseInt(phaseBudgetRaw, 10);
  if (!Number.isFinite(phaseBudget) || phaseBudget <= 0) {
    console.error(
      `[bundle-size] FAIL: invalid CCAUDIT_PHASE_BUDGET_BYTES: ${JSON.stringify(phaseBudgetRaw)}`,
    );
    process.exit(1);
  }
  const phaseDelta = actual - phaseBaseline;
  console.log(
    `[bundle-size] phase-local baseline=${phaseBaseline}B delta=${phaseDelta}B budget=${phaseBudget}B`,
  );
  if (phaseDelta > phaseBudget) {
    console.error(
      `[bundle-size] FAIL: phase-local delta exceeds ${phaseBudget}B (${phaseDelta} > ${phaseBudget})`,
    );
    process.exit(1);
  }
}

process.exit(0);

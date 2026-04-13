/**
 * E2E regression test for Gap #4: --no-color visibility in --help output.
 *
 * D-07 mandates initColor() reads process.argv directly for root-level positioning,
 * but the original implementation at _shared-args.ts EXCLUDED 'no-color' from gunshi's
 * declared args, making the flag invisible in every --help output. Gap #4 fix adds
 * 'no-color' to outputArgs (declaration only — initColor remains the runtime source).
 *
 * This test spawns the built dist/index.js binary and greps --help output on root
 * plus every subcommand for the 'no-color' substring. Serves as permanent regression
 * guard: if any subcommand loses the outputArgs spread, this test fails.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the dist binary relative to this test file's location, NOT cwd —
// vitest runs tests with cwd=apps/ccaudit (pnpm -F scope), so a cwd-relative
// path double-nests to apps/ccaudit/apps/ccaudit. Mirrors dry-run-command.test.ts
// pattern: __tests__ lives at apps/ccaudit/src/__tests__ → dist is ../../dist.
const here = path.dirname(fileURLToPath(import.meta.url));
const BINARY = path.resolve(here, '..', '..', 'dist', 'index.js');

// NOTE: This test REQUIRES `apps/ccaudit/dist/index.js` to exist before vitest runs.
// We do NOT rebuild inside beforeAll because tsdown cleans dist/ before writing,
// which races with parallel tests (dry-run-command.test.ts) that spawn the same
// binary — producing transient ENOENT failures. Run `pnpm -F ccaudit build` before
// `pnpm test` as a prerequisite. CI covers this via a dedicated build step.
const binaryExists = existsSync(BINARY);

function runHelp(args: string[]): string {
  const result = spawnSync('node', [BINARY, ...args], {
    encoding: 'utf-8',
    timeout: 10000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  // Combine stdout + stderr; gunshi may emit help to either depending on version.
  return (result.stdout ?? '') + (result.stderr ?? '');
}

describe.skipIf(!binaryExists)('Gap #4 regression: --no-color visible in --help', () => {
  it('root ccaudit --help lists no-color', () => {
    const output = runHelp(['--help']);
    expect(output).toContain('no-color');
  });

  it('ccaudit ghost --help lists no-color', () => {
    const output = runHelp(['ghost', '--help']);
    expect(output).toContain('no-color');
  });

  it('ccaudit inventory --help lists no-color', () => {
    const output = runHelp(['inventory', '--help']);
    expect(output).toContain('no-color');
  });

  it('ccaudit mcp --help lists no-color', () => {
    const output = runHelp(['mcp', '--help']);
    expect(output).toContain('no-color');
  });

  it('ccaudit trend --help lists no-color', () => {
    const output = runHelp(['trend', '--help']);
    expect(output).toContain('no-color');
  });
});

describe.skipIf(!binaryExists)('DOCS-04: v1.3.0 flag visibility in --help', () => {
  it('ghost --help lists --verbose, --no-group-frameworks, --force-partial', () => {
    const output = runHelp(['ghost', '--help']);
    expect(output).toContain('--verbose');
    expect(output).toContain('--no-group-frameworks');
    expect(output).toContain('--force-partial');
  });

  it('inventory --help lists --verbose and --no-group-frameworks', () => {
    const output = runHelp(['inventory', '--help']);
    expect(output).toContain('--verbose');
    expect(output).toContain('--no-group-frameworks');
  });

  it('inventory --help does NOT list --force-partial (bust-only flag)', () => {
    const output = runHelp(['inventory', '--help']);
    expect(output).not.toContain('--force-partial');
  });
});

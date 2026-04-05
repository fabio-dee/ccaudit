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
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the dist binary relative to this test file's location, NOT cwd —
// vitest runs tests with cwd=apps/ccaudit (pnpm -F scope), so a cwd-relative
// path double-nests to apps/ccaudit/apps/ccaudit. Mirrors dry-run-command.test.ts
// pattern: __tests__ lives at apps/ccaudit/src/__tests__ → dist is ../../dist.
const here = path.dirname(fileURLToPath(import.meta.url));
const BINARY = path.resolve(here, '..', '..', 'dist', 'index.js');

function runHelp(args: string[]): string {
  const result = spawnSync('node', [BINARY, ...args], {
    encoding: 'utf-8',
    timeout: 10000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  // Combine stdout + stderr; gunshi may emit help to either depending on version.
  return (result.stdout ?? '') + (result.stderr ?? '');
}

describe('Gap #4 regression: --no-color visible in --help', () => {
  beforeAll(() => {
    // Ensure the binary is built. This is idempotent — tsdown reuses cached output
    // when sources are unchanged. Other integration tests (dry-run-command.test.ts)
    // rely on the same invariant.
    execSync('pnpm -F ccaudit build', { stdio: 'pipe' });
  });

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

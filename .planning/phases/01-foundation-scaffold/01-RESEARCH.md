# Phase 1: Foundation & Scaffold - Research

**Researched:** 2026-04-03
**Domain:** TypeScript monorepo scaffold, CLI skeleton, build pipeline, zero-dep bundling, CI
**Confidence:** HIGH

## Summary

Phase 1 establishes the monorepo structure, build pipeline, CLI skeleton, test infrastructure, linting/formatting, and CI pipeline. The goal is that `npx ccaudit --help` works from a built binary with zero runtime dependencies. Every technology choice is validated against the ccusage reference implementation and verified against current npm registry versions.

The primary risk in this phase is configuration -- getting tsdown, vitest in-source testing, pnpm catalogs, and the publishConfig bin/exports pattern wired correctly. All patterns are documented from ccusage source code study and have HIGH confidence. The shebang-in-source approach (placing `#!/usr/bin/env node` directly in `src/index.ts` rather than using `outputOptions.banner`) is confirmed as what ccusage actually does.

**Primary recommendation:** Follow the ccusage reference implementation pattern-for-pattern. Every configuration detail documented below is verified from actual ccusage source code. Do not deviate unless explicitly noted.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DIST-01 | Tool executes via `npx ccaudit@latest` with zero pre-installation required | Shebang injection pattern, publishConfig bin field, tsdown bundling, `clean-pkg-json` prepack lifecycle -- all verified from ccusage |
| DIST-02 | All runtime dependencies bundled at build time; published package has zero runtime `dependencies` | Zero-dep strategy: all deps in devDependencies, tsdown bundles into single file, `clean-pkg-json` strips dev fields, `npm pack --dry-run` CI verification |
| DIST-03 | Dual path support: XDG (`~/.config/claude/`) and legacy (`~/.claude/`) paths resolved automatically | Path resolution pattern documented from ccusage; `os.homedir()` + dual path scan. Implementation is Phase 2 but the shared types and directory structure must support it |
| DIST-04 | Malformed or schema-invalid JSONL lines silently skipped -- tool never throws on corrupt session data | valibot `safeParse` pattern documented; parser is Phase 2 but the valibot dependency and schema pattern must be available |
| DIST-05 | `engines` field declares minimum Node.js version (20.x LTS) | Verified Node.js 22.20.0 available locally; `engines: { "node": ">=20.0.0" }` in package.json |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

The following directives from CLAUDE.md constrain all planning:

- **Runtime deps**: Zero -- all deps as `devDependencies`, bundler owns the payload
- **Distribution**: `npx ccaudit@latest` -- zero-install
- **Tech stack**: TypeScript/Node, gunshi CLI, tinyglobby, valibot safeParse, cli-table3, tsdown, vitest in-source tests, pnpm workspaces
- **Monorepo layout**: `apps/ccaudit/`, `apps/ccaudit-mcp/` (future), `packages/internal/`, `packages/terminal/`, `docs/`
- **GSD Workflow**: All file changes must go through GSD commands
- **Shebang**: Source-file shebang in `src/index.ts`, NOT `outputOptions.banner`
- **tsdown define**: Top-level `define: { 'import.meta.vitest': 'undefined' }`, NOT `inputOptions.define`
- **publishConfig**: Dual `bin`/`publishConfig.bin` pattern -- source `bin` points to `.ts`, published `bin` points to `.js`
- **Catalog mode**: `strict` -- all versions managed through pnpm catalogs

## Standard Stack

### Core (Phase 1 Scope)

| Library | Registry Version | Purpose | Why Standard |
|---------|-----------------|---------|--------------|
| TypeScript | 6.0.2 | Language | Standard; ccusage runs TS throughout |
| Node.js | >=20.0.0 (local: 22.20.0) | Runtime | LTS; `node:readline`, `node:fs/promises`, `node:path` |
| pnpm | 10.33.0 (local) | Package manager | ccusage uses 10.x; catalogs require 9.5+ |
| gunshi | 0.29.3 | CLI framework | ccusage-proven; type-safe args; auto --help/--version |
| valibot | 1.3.1 | Schema validation | Tree-shakable ~1KB; `safeParse()` for silent skip |
| tsdown | 0.21.7 | Bundler | Rust-based (Rolldown); ccusage-proven; publint integration |
| vitest | 4.1.2 | Test runner | In-source testing via `import.meta.vitest` |
| clean-pkg-json | 1.4.1 | Prepack cleanup | Strips devDependencies from published package.json |
| only-allow | 1.2.2 | Package manager enforcement | Prevents accidental npm/yarn install |

### Build & Lint

| Library | Registry Version | Purpose | When to Use |
|---------|-----------------|---------|-------------|
| eslint | 10.1.0 | Linting | Flat config (eslint.config.ts); TypeScript-aware |
| typescript-eslint | 8.58.0 | TS lint rules | Type-aware linting in monorepo |
| @eslint/js | 10.0.1 | JS lint rules | Base recommended rules |
| oxfmt | 0.43.0 | Formatting | 30x faster than Prettier; 100% compatible output |
| @types/node | 25.5.2 | Node types | TypeScript declarations for Node.js APIs |

### Release (deferred setup, listed for catalog)

| Library | Registry Version | Purpose | When to Use |
|---------|-----------------|---------|-------------|
| bumpp | 11.0.1 | Version bumping | `bumpp -r` for monorepo version management |
| changelogithub | 14.0.0 | Release notes | Auto-generate GitHub Release from conventional commits |
| picocolors | 1.1.1 | Terminal colors | Non-table color output (warnings, progress) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| gunshi | commander.js | No type-safe args, larger bundle, no auto --help formatting |
| tsdown | tsup | Legacy predecessor; slower; less tree-shaking |
| vitest | jest | No in-source testing; worse TS integration |
| oxfmt | Prettier | 30x slower; ccusage uses oxfmt |
| valibot | zod | Cannot tree-shake (13KB min vs valibot ~1KB) |

**Installation (root workspace):**
```bash
# Initialize monorepo
pnpm init

# All deps go through catalog — individual package.json files reference catalog:
# See pnpm-workspace.yaml catalog section below
```

## Architecture Patterns

### Recommended Project Structure
```
ccaudit-aka-ghostbuster/
  apps/
    ccaudit/                     # Main CLI package
      src/
        index.ts                 # Entry point (shebang + run())
        cli/
          index.ts               # gunshi router
          commands/
            ghost.ts             # Default command (stub for Phase 1)
        pipeline.ts              # Will compose components (stub for Phase 1)
      package.json
      tsdown.config.ts
      tsconfig.json
      vitest.config.ts
    ccaudit-mcp/                 # Future MCP server (empty dir for Phase 1)
  packages/
    internal/                    # @ccaudit/internal (shared types/utils)
      src/
        types.ts                 # Shared type definitions
        index.ts                 # Barrel export
      package.json
      tsconfig.json
      vitest.config.ts
    terminal/                    # @ccaudit/terminal (table rendering)
      src/
        index.ts                 # Barrel export (stub)
      package.json
      tsconfig.json
      vitest.config.ts
  docs/                          # VitePress docs (placeholder)
  pnpm-workspace.yaml            # Workspace + catalogs + security
  package.json                   # Root scripts + engines + packageManager
  tsconfig.json                  # Root TypeScript config
  vitest.config.ts               # Root vitest workspace config
  eslint.config.ts               # Root eslint flat config
  .oxfmtrc.jsonc                 # oxfmt config
  .github/
    workflows/
      ci.yaml                    # Lint + typecheck + test + build
```

### Pattern 1: CLI Entry Point with Shebang in Source

**What:** Place the shebang directly in the TypeScript source file. tsdown preserves it in output.
**When to use:** Always for CLI entry points.
**Source:** ccusage `apps/ccusage/src/index.ts`

```typescript
// apps/ccaudit/src/index.ts
#!/usr/bin/env node
import { run } from './cli/index.ts';
await run();
```

### Pattern 2: gunshi Command Router with Subcommands

**What:** Define commands with `define()`, register via `cli()` with `subCommands` option.
**When to use:** CLI entry point routing.
**Source:** ccusage `apps/ccusage/src/commands/index.ts`, gunshi docs

```typescript
// apps/ccaudit/src/cli/index.ts
import { cli, define } from 'gunshi';
import { version } from '../../package.json' with { type: 'json' };

// For Phase 1: minimal ghost command that prints placeholder
const ghostCommand = define({
  name: 'ghost',
  description: 'Show ghost inventory report (default)',
  args: {
    since: {
      type: 'string',
      short: 's',
      description: 'Time window for ghost detection (e.g., 7d, 30d)',
      default: '7d',
    },
    json: {
      type: 'boolean',
      short: 'j',
      description: 'Output as JSON',
      default: false,
    },
  },
  run(ctx) {
    console.log('ccaudit ghost: not yet implemented');
    console.log(`Options: since=${ctx.values.since}, json=${ctx.values.json}`);
  },
});

export async function run(): Promise<void> {
  let args = process.argv.slice(2);
  // Handle npx double-name edge case
  if (args[0] === 'ccaudit') args = args.slice(1);

  await cli(args, ghostCommand, {
    name: 'ccaudit',
    version,
    description: 'Audit Claude Code ghost inventory — agents, skills, MCP servers, and memory files',
    subCommands: {
      ghost: ghostCommand,
      // Future: inventory, mcp, trend, restore, contribute
    },
  });
}
```

### Pattern 3: tsdown Config (Verified from ccusage)

**What:** ESM-only bundler config with test stripping, tree-shaking, and publint validation.
**Source:** ccusage `apps/ccusage/tsdown.config.ts`

```typescript
// apps/ccaudit/tsdown.config.ts
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/*.ts', '!./src/**/*.test.ts', '!./src/_*.ts'],
  outDir: 'dist',
  format: 'esm',
  clean: true,
  sourcemap: false,
  minify: 'dce-only',
  treeshake: true,
  publint: true,
  unused: true,
  nodeProtocol: true,
  define: {
    'import.meta.vitest': 'undefined',  // Strip in-source tests from production
  },
});
```

### Pattern 4: package.json with publishConfig Dual Bin

**What:** Source `bin` points to `.ts` for dev; `publishConfig.bin` points to built `.js` for npm.
**Source:** ccusage `apps/ccusage/package.json`

```jsonc
// apps/ccaudit/package.json
{
  "name": "ccaudit",
  "version": "0.0.1",
  "type": "module",
  "description": "Audit Claude Code ghost inventory",
  "bin": {
    "ccaudit": "./src/index.ts"
  },
  "publishConfig": {
    "bin": {
      "ccaudit": "./dist/index.js"
    },
    "exports": {
      ".": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "build": "tsdown",
    "test": "TZ=UTC vitest",
    "typecheck": "tsc --noEmit",
    "prepack": "pnpm run build && clean-pkg-json"
  },
  "devDependencies": {
    "@ccaudit/internal": "workspace:*",
    "@ccaudit/terminal": "workspace:*",
    "gunshi": "catalog:",
    "valibot": "catalog:",
    "tsdown": "catalog:",
    "vitest": "catalog:",
    "clean-pkg-json": "catalog:",
    "typescript": "catalog:",
    "@types/node": "catalog:"
  }
}
```

### Pattern 5: pnpm Workspace with Catalogs and Security

**What:** Strict catalog mode, security hardening, named catalogs.
**Source:** ccusage `pnpm-workspace.yaml`

```yaml
# pnpm-workspace.yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'docs'

catalog:
  # CLI Runtime (all bundled as devDeps)
  gunshi: ^0.29.3
  valibot: ^1.3.1
  tinyglobby: ^0.2.15
  cli-table3: ^0.6.5
  '@praha/byethrow': ^0.10.1
  picocolors: ^1.1.1

  # Build
  tsdown: ^0.21.7
  vitest: ^4.1.2
  clean-pkg-json: ^1.4.1
  typescript: ^6.0.2

  # Lint & Format
  eslint: ^10.1.0
  typescript-eslint: ^8.58.0
  '@eslint/js': ^10.0.1
  oxfmt: ^0.43.0

  # Types
  '@types/node': ^25.5.2

  # Release
  bumpp: ^11.0.1
  changelogithub: ^14.0.0
  only-allow: ^1.2.2

catalogMode: strict

# Supply-chain security (ccusage pattern)
strictDepBuilds: true
blockExoticSubdeps: true
```

### Pattern 6: Vitest In-Source Testing

**What:** Tests live alongside implementation code, stripped from production builds.
**Source:** vitest official docs, ccusage `apps/ccusage/vitest.config.ts`

```typescript
// apps/ccaudit/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    watch: false,
    includeSource: ['src/**/*.{js,ts}'],
    globals: true,
  },
});
```

```typescript
// vitest.config.ts (root -- workspace orchestrator)
import { defineConfig } from 'vitest/config';

const isCI = !!process.env.CI;

export default defineConfig({
  test: {
    passWithNoTests: true,
    watch: false,
    reporters: isCI ? ['default', 'github-actions'] : ['default'],
    projects: ['apps/*/vitest.config.ts', 'packages/*/vitest.config.ts'],
  },
});
```

TypeScript declaration needed in each `tsconfig.json`:
```json
{
  "compilerOptions": {
    "types": ["vitest/importMeta"]
  }
}
```

Example in-source test:
```typescript
// packages/internal/src/types.ts
export interface GhostItem {
  name: string;
  path: string;
  scope: 'global' | 'project';
  status: 'used' | 'ghost';
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe('GhostItem', () => {
    it('should accept valid ghost items', () => {
      const item: GhostItem = {
        name: 'test-agent',
        path: '/home/user/.claude/agents/test.md',
        scope: 'global',
        status: 'ghost',
      };
      expect(item.status).toBe('ghost');
    });
  });
}
```

### Pattern 7: ESLint Flat Config for TypeScript Monorepo

**What:** ESLint 10 flat config with typescript-eslint for type-aware linting.
**Source:** typescript-eslint docs, eslint flat config docs

```typescript
// eslint.config.ts
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
);
```

### Pattern 8: oxfmt Configuration

**What:** Rust-based formatter, 30x faster than Prettier, 100% compatible output.
**Source:** oxfmt docs, ccusage `.oxfmtrc.jsonc`

```jsonc
// .oxfmtrc.jsonc
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "printWidth": 100,
  "singleQuote": true,
  "trailingComma": "all",
  "semi": true
}
```

### Pattern 9: GitHub Actions CI Pipeline

**What:** CI pipeline for pnpm monorepo: lint, typecheck, test, build, pack verification.
**Source:** ccusage `.github/workflows/ci.yaml`, pnpm CI docs

```yaml
# .github/workflows/ci.yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format:check

  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build
      # Verify binary executes
      - run: node apps/ccaudit/dist/index.js --help
      # Verify zero runtime deps
      - run: cd apps/ccaudit && npm pack --dry-run 2>&1
```

### Anti-Patterns to Avoid

- **Dependencies in `dependencies` field**: Everything goes in `devDependencies`. tsdown bundles at build time.
- **`outputOptions.banner` for shebang**: Use source-file shebang instead. This is what ccusage does.
- **`inputOptions.define` for vitest stripping**: Use top-level `define` in tsdown config.
- **`require()` or CJS patterns**: ESM only (`"type": "module"`).
- **Relative path string concatenation**: Always `path.join()` or `path.posix.join()` for globs.
- **`npm install` or `yarn install`**: Only pnpm. Enforced via `only-allow` preinstall hook.
- **Lazy subcommand loading**: ccusage does NOT use it. Eager imports are fine for 4-5 commands.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| CLI arg parsing | Custom arg parser | gunshi `define()` + `cli()` | Type-safe, auto --help/--version, tested framework |
| Schema validation | Manual JSON field checks | valibot `safeParse()` | Non-throwing, tree-shakable, branded types |
| File globbing | Manual `readdir` + regex | tinyglobby `glob()` | Handles forward-slash normalization, ignore patterns, async |
| Terminal tables | Manual column alignment | cli-table3 | Word wrap, ANSI colors, column spanning, responsive |
| Bundle + tree-shake | Manual rollup config | tsdown `defineConfig()` | Rust-based, publint validation, DTS generation |
| Published package cleanup | Manual package.json editing | clean-pkg-json | Strips devDeps, replaces exports with publishConfig |
| Package manager enforcement | README note | only-allow preinstall | Hard gate -- npm/yarn cannot install |

**Key insight:** The ccusage ecosystem already solved every infrastructure problem. The fastest path is to replicate, not reinvent.

## Common Pitfalls

### Pitfall 1: Shebang Missing from Built Binary (H5)
**What goes wrong:** `npx ccaudit` fails with "cannot execute" because `dist/index.js` lacks `#!/usr/bin/env node`.
**Why it happens:** tsdown does NOT add shebangs automatically (unlike tsup which has `--shims`).
**How to avoid:** Place `#!/usr/bin/env node` as the first line of `apps/ccaudit/src/index.ts`. tsdown preserves it in output.
**Warning signs:** `file dist/index.js` does not show "script text" or first line is not `#!/usr/bin/env node`.
**Verification:** CI step: `head -1 apps/ccaudit/dist/index.js | grep -q '#!/usr/bin/env node'`

### Pitfall 2: Runtime Dependencies Leaking into Published Package (C5)
**What goes wrong:** A library ends up in `dependencies` instead of `devDependencies`, breaking the zero-install promise.
**Why it happens:** Muscle memory from conventional package development. Workspace references (`workspace:*`) can also leak.
**How to avoid:** Never create a `dependencies` field. All deps in `devDependencies`. `clean-pkg-json` in prepack. CI verification with `npm pack --dry-run`.
**Warning signs:** `npm pack --dry-run` output shows `dependencies` section with entries.
**Verification:** CI step: `cd apps/ccaudit && npm pack --dry-run 2>&1`

### Pitfall 3: import.meta.vitest Not Stripped in Production (M9)
**What goes wrong:** In-source test code ships in the published bundle, increasing size and potentially exposing test utilities.
**Why it happens:** tsdown `define` property misconfigured or missing.
**How to avoid:** `define: { 'import.meta.vitest': 'undefined' }` as a top-level property in `tsdown.config.ts`.
**Warning signs:** `dist/index.js` contains strings like `describe(` or `expect(`.
**Verification:** CI step: `! grep -q 'import.meta.vitest' apps/ccaudit/dist/index.js`

### Pitfall 4: Workspace Package References in Published Tarball (M10)
**What goes wrong:** Published `package.json` contains `"@ccaudit/internal": "workspace:*"` which npm cannot resolve.
**Why it happens:** `clean-pkg-json` not running or misconfigured in prepack.
**How to avoid:** `"prepack": "pnpm run build && clean-pkg-json"` in `apps/ccaudit/package.json`.
**Warning signs:** `npm pack --dry-run` tarball contents show `workspace:` in any dependency version.

### Pitfall 5: gunshi Breaking Changes (L5)
**What goes wrong:** gunshi is pre-1.0 (0.29.x). Minor version bumps may change API.
**Why it happens:** Semantic versioning for pre-1.0 treats minor versions as potentially breaking.
**How to avoid:** Pin to `^0.29.3` in catalog. In-source tests cover command definitions. Check changelog before any upgrade.
**Warning signs:** Build failure in command definition files after `pnpm update`.

### Pitfall 6: pnpm Catalog Strict Mode Blocks Ad-Hoc Installs
**What goes wrong:** `pnpm add some-package` fails because `catalogMode: strict` rejects versions not in catalog.
**Why it happens:** Strict mode requires all versions to be defined in the workspace catalog first.
**How to avoid:** Add the dependency to `pnpm-workspace.yaml` catalog first, then reference with `catalog:` protocol.
**Warning signs:** pnpm error about catalog version mismatch during install.

## Code Examples

### Example 1: Root package.json
```jsonc
// package.json (root)
{
  "name": "ccaudit-monorepo",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20.0.0"
  },
  "packageManager": "pnpm@10.33.0",
  "scripts": {
    "preinstall": "npx only-allow pnpm",
    "build": "pnpm -r build",
    "test": "TZ=UTC vitest",
    "lint": "eslint .",
    "format": "oxfmt --write .",
    "format:check": "oxfmt --check .",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "eslint": "catalog:",
    "typescript-eslint": "catalog:",
    "@eslint/js": "catalog:",
    "oxfmt": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:",
    "@types/node": "catalog:"
  }
}
```

### Example 2: Workspace Package (packages/internal)
```jsonc
// packages/internal/package.json
{
  "name": "@ccaudit/internal",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "TZ=UTC vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "valibot": "catalog:",
    "tinyglobby": "catalog:",
    "@praha/byethrow": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:",
    "@types/node": "catalog:"
  }
}
```

### Example 3: TypeScript Config (Root)
```jsonc
// tsconfig.json (root)
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": ".",
    "types": ["vitest/importMeta"]
  },
  "exclude": ["**/node_modules/**", "**/dist/**"]
}
```

### Example 4: Package TypeScript Config
```jsonc
// apps/ccaudit/tsconfig.json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts"],
  "references": [
    { "path": "../../packages/internal" },
    { "path": "../../packages/terminal" }
  ]
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| tsup (esbuild) | tsdown (Rolldown/Rust) | 2025-2026 | Faster tree-shaking, publint integration, better DCE |
| Prettier | oxfmt | 2025-2026 (beta Feb 2026) | 30x faster, 100% Prettier JS/TS compatible output |
| eslintrc (.eslintrc.json) | Flat config (eslint.config.ts) | ESLint 9+ (2024), v10 removed legacy (2026) | TypeScript config files, simpler plugin system |
| `@types/node` v20-22 | `@types/node` v25 | 2026 | Node.js 22+ API types |
| npm workspaces | pnpm workspaces + catalogs | pnpm 9.5+ (2024) | Centralized version management, strict mode |

**Deprecated/outdated:**
- `tsup`: Replaced by `tsdown`. Same author ecosystem, Rust-based backend.
- `.eslintrc.*` config format: Removed in ESLint 10 (March 2026).
- `Prettier`: Still works but ccusage ecosystem uses `oxfmt`.

## Open Questions

1. **TypeScript 6.0 compatibility with tsdown**
   - What we know: npm shows TypeScript 6.0.2 as latest. tsdown 0.21.7 should support it.
   - What's unclear: Whether tsdown's DTS generation works correctly with TS 6.0 features.
   - Recommendation: Use `^6.0.2` in catalog. If DTS issues arise, tsdown's `dts: false` is fine since we only publish a bundled JS file (no type exports needed for CLI).

2. **oxfmt eslint integration**
   - What we know: `eslint-plugin-oxfmt` exists for running oxfmt as an eslint rule.
   - What's unclear: Whether to use the plugin or keep lint and format as separate commands.
   - Recommendation: Keep separate (`pnpm lint` and `pnpm format:check`). Simpler, follows ccusage pattern.

3. **pnpm `packageManager` field exact version**
   - What we know: Local pnpm is 10.33.0. ccusage uses 10.30.1.
   - What's unclear: Whether corepack enforces this strictly in CI.
   - Recommendation: Set `"packageManager": "pnpm@10.33.0"` and let `pnpm/action-setup@v4` in CI use whatever version is specified.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | Yes | 22.20.0 | -- |
| pnpm | Package manager | Yes | 10.33.0 | -- |
| npm | `npm pack --dry-run` verification | Yes | 10.9.3 | -- |
| git | Version control, CI | Yes | (system) | -- |
| oxfmt | Formatting | No (not installed globally) | 0.43.0 on npm | Install via `pnpm add -D oxfmt` in workspace |

**Missing dependencies with no fallback:** None -- all tools are installable via pnpm.

**Missing dependencies with fallback:**
- `oxfmt` not globally installed but will be added as devDependency via catalog.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.2 |
| Config file | `vitest.config.ts` (root workspace) + `apps/*/vitest.config.ts` + `packages/*/vitest.config.ts` |
| Quick run command | `pnpm test` |
| Full suite command | `TZ=UTC pnpm -r test` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DIST-01 | `npx ccaudit --help` executes and prints usage | smoke | `node apps/ccaudit/dist/index.js --help` | Wave 0 |
| DIST-02 | Zero runtime `dependencies` in published package | smoke | `cd apps/ccaudit && npm pack --dry-run 2>&1` | Wave 0 |
| DIST-03 | Dual path types available for downstream phases | unit | `pnpm -C packages/internal test` | Wave 0 |
| DIST-04 | valibot safeParse pattern available | unit | `pnpm -C packages/internal test` | Wave 0 |
| DIST-05 | `engines` field declares Node.js >=20.x | smoke | `node -e "const p=require('./apps/ccaudit/package.json'); assert(p.engines.node)"` | Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test` (quick run)
- **Per wave merge:** `TZ=UTC pnpm -r test && pnpm -r build && node apps/ccaudit/dist/index.js --help`
- **Phase gate:** Full suite green + `npm pack --dry-run` verification + shebang check

### Wave 0 Gaps
- [ ] `apps/ccaudit/vitest.config.ts` -- vitest config with includeSource
- [ ] `packages/internal/vitest.config.ts` -- vitest config with includeSource
- [ ] `packages/terminal/vitest.config.ts` -- vitest config with includeSource
- [ ] `vitest.config.ts` (root) -- workspace vitest config
- [ ] Framework install: `pnpm install` after catalog and package.json creation
- [ ] tsconfig.json with `"types": ["vitest/importMeta"]` for in-source test support

## Sources

### Primary (HIGH confidence)
- ccusage source code (direct reading) -- tsdown.config.ts, package.json, vitest.config.ts, CLI entry, commands/index.ts
- [gunshi docs - Getting Started](https://gunshi.dev/guide/essentials/getting-started) -- `define()` + `cli()` API
- [gunshi docs - Composable](https://gunshi.dev/guide/essentials/composable) -- Subcommand registration pattern
- [vitest docs - In-Source Testing](https://vitest.dev/guide/in-source) -- `import.meta.vitest` pattern and build stripping
- [pnpm docs - Catalogs](https://pnpm.io/catalogs) -- Catalog protocol, strict mode, named catalogs
- [pnpm docs - CI](https://pnpm.io/continuous-integration) -- GitHub Actions setup
- [oxfmt docs](https://oxc.rs/docs/guide/usage/formatter/config) -- `.oxfmtrc.jsonc` configuration
- [tsdown docs - Shims](https://tsdown.dev/options/shims) -- Shim behavior (shebang NOT covered here; source-file approach is ccusage-proven)

### Secondary (MEDIUM confidence)
- [typescript-eslint - Getting Started](https://typescript-eslint.io/getting-started/) -- Flat config with `tseslint.config()`
- [ESLint 10 release](https://www.infoq.com/news/2026/04/eslint-10-release/) -- Flat config is now the only option
- [pnpm/action-setup](https://github.com/pnpm/action-setup) -- GitHub Actions v4 setup

### Tertiary (LOW confidence)
- ESLint monorepo flat config patterns from community discussions (verified against official docs)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- every version verified against npm registry 2026-04-03, all patterns from ccusage source code
- Architecture: HIGH -- monorepo structure and patterns replicated from ccusage production code
- Build pipeline: HIGH -- tsdown, vitest, publishConfig patterns all verified from ccusage source
- CI: MEDIUM -- based on ccusage CI + pnpm official docs; exact CI yaml not verified running
- Pitfalls: HIGH -- scaffold pitfalls (C5, H5, M9, M10) documented with verification steps

**Research date:** 2026-04-03
**Valid until:** 2026-05-03 (30 days -- stable domain, pinned versions)

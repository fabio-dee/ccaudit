# Stack Research -- ccaudit

**Project:** ccaudit (Claude Code ghost inventory auditor)
**Researched:** 2026-04-03
**Research mode:** Ecosystem (stack validation + gap filling)
**Primary reference:** [ryoppippi/ccusage](https://github.com/ryoppippi/ccusage) architecture

---

## Confirmed Stack (Validated)

The chosen stack is sound. Every library is actively maintained, used together in production by ccusage, and fits the zero-runtime-deps constraint. Validation notes per component:

### Core Framework

| Technology | Version | Purpose | Confidence | Rationale |
|------------|---------|---------|------------|-----------|
| **TypeScript** | ~5.7+ | Language | HIGH | Standard. ccusage runs TS throughout. |
| **Node.js** | >=20.x | Runtime | HIGH | LTS. Required for `node:readline`, `node:fs/promises`, `node:path`. Shebang targets `#!/usr/bin/env node`. |
| **pnpm** | 10.x | Package manager | HIGH | ccusage uses 10.30.1. Enforced via `npx only-allow pnpm` preinstall script. Catalogs require pnpm 9.5+. |

### CLI & Parsing

| Technology | Version | Purpose | Confidence | Rationale |
|------------|---------|---------|------------|-----------|
| **gunshi** | ^0.29.x | CLI framework | HIGH | ccusage's author (ryoppippi) chose gunshi over commander/cleye. Type-safe args, lazy subcommands, tiny bundle. Actively maintained (0.29.2, 12 days ago). |
| **valibot** | ^1.3.x | Schema validation | HIGH | v1.3.1 (14 days ago). `safeParse()` returns `{ success, output, issues }` -- perfect for silent JSONL skip. Tree-shakable (only imported functions bundled). Zero deps. |
| **tinyglobby** | ^0.2.x | File discovery | HIGH | 0.2.15. Only 2 subdependencies vs globby's 23. Async `glob()` and sync `globSync()` with ignore patterns. |

### Display & UX

| Technology | Version | Purpose | Confidence | Rationale |
|------------|---------|---------|------------|-----------|
| **cli-table3** | ^0.6.x | Terminal tables | HIGH | 0.6.5. Stable, 4750+ dependents. Built-in TS types. Supports column spanning, word wrapping, ANSI colors. |
| **picocolors** | ^1.x | Terminal colors | HIGH | Used by ccusage for non-table color output (warnings, progress). Minimal, auto-detects NO_COLOR/FORCE_COLOR. |

### Error Handling

| Technology | Version | Purpose | Confidence | Rationale |
|------------|---------|---------|------------|-----------|
| **@praha/byethrow** | ^0.10.x | Result type | MEDIUM | 0.10.1 (2 days ago). ccusage uses this exact lib. Tree-shakable, plain-object Results (no classes), `andThen`/`andThrough` chaining. Newer library (smaller community), but battle-tested in ccusage. |

### Build & Bundle

| Technology | Version | Purpose | Confidence | Rationale |
|------------|---------|---------|------------|-----------|
| **tsdown** | ^0.20.x | Bundler | HIGH | 0.20.3+ (Rolldown-powered, Rust-based). Successor to tsup. Tree-shaking by default. `outputOptions.banner` for shebang injection. `publint: true` validates package structure at build time. |
| **vitest** | ^4.1.x | Test runner | HIGH | 4.1.2. In-source testing via `if (import.meta.vitest)` blocks. Strips test code from production via `define: { 'import.meta.vitest': 'undefined' }`. |

### Monorepo Layout (Confirmed)

```
ccaudit/
  apps/
    ccaudit/           # Main CLI package (bin: ccaudit)
    ccaudit-mcp/       # Future MCP server
  packages/
    internal/          # @ccaudit/internal -- shared types, schemas, JSONL parser
    terminal/          # @ccaudit/terminal -- table rendering, formatters
  docs/                # VitePress documentation
  pnpm-workspace.yaml
```

This mirrors ccusage's layout exactly (`apps/*`, `packages/internal`, `packages/terminal`, `docs`).

---

## Gaps to Fill

### 1. Shebang Injection (source-file approach)

**Status:** Not configured yet.
**Solution:** Place shebang directly in source file (not tsdown config). This is what ccusage actually does:

```typescript
// apps/ccaudit/src/index.ts
#!/usr/bin/env node
import { run } from './commands/index.ts';
await run();
```

tsdown preserves the shebang in output. No `outputOptions.banner` needed (the sitemcp pattern works too, but ccusage's source-file approach is simpler).

**tsdown config** (from actual ccusage `apps/ccusage/tsdown.config.ts`):
```typescript
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
    'import.meta.vitest': 'undefined',  // Strip in-source tests
  },
});
```

**Confidence:** HIGH -- verified from actual ccusage source code.

### 2. package.json `bin` Field (with publishConfig)

**Status:** Not configured yet.
**Solution:** ccusage uses a dual `bin`/`publishConfig.bin` pattern — source `bin` points to `.ts` for dev, published `bin` points to `.js`:

```jsonc
// apps/ccaudit/package.json
{
  "name": "ccaudit",
  "type": "module",
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
  "scripts": {
    "build": "tsdown",
    "test": "TZ=UTC vitest",
    "prepack": "pnpm run build && clean-pkg-json"
  },
  "devDependencies": {
    "gunshi": "catalog:runtime",
    "valibot": "catalog:runtime",
    "tinyglobby": "catalog:runtime",
    "cli-table3": "catalog:runtime",
    "@praha/byethrow": "catalog:runtime",
    "tsdown": "catalog:build",
    "vitest": "catalog:testing",
    "clean-pkg-json": "catalog:release"
  }
  // NO "dependencies" block -- zero runtime deps
}
```

**Confidence:** HIGH -- verified from actual ccusage source code (dual bin pattern confirmed).

### 3. In-Source Testing (vitest config)

**Status:** Needs explicit config for `import.meta.vitest` stripping.
**Solution:**

```typescript
// vitest.config.ts (root)
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    includeSource: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
  },
});
```

For production builds, tsdown must strip test blocks. Use top-level `define` property:

```typescript
// In tsdown.config.ts (already shown in section 1 above):
define: {
  'import.meta.vitest': 'undefined',
},
```

**Confidence:** HIGH -- verified from actual ccusage `tsdown.config.ts`. The correct syntax is top-level `define`, not `inputOptions.define` or `rolldownOptions.define`.

### 4. pnpm Catalog Configuration

**Status:** Not configured yet.
**Solution:** Use strict catalog mode (ccusage pattern):

```yaml
# pnpm-workspace.yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'docs'

catalog:
  # CLI
  gunshi: ^0.29.2
  valibot: ^1.3.1
  tinyglobby: ^0.2.15
  cli-table3: ^0.6.5
  '@praha/byethrow': ^0.10.1

  # Build
  tsdown: ^0.20.3
  vitest: ^4.1.2
  clean-pkg-json: ^1.3.0
  unplugin-unused: ^0.4.0

  # Lint & Format
  eslint: ^9.0.0
  oxfmt: ^0.10.0

  # Types
  '@types/node': ^22.0.0

catalogMode: strict
```

**Confidence:** HIGH -- pnpm catalogs are well-documented and ccusage uses this exact approach.

### 5. CI/CD Pipeline (GitHub Actions)

**Status:** Not planned yet.
**Solution:** Replicate ccusage's CI pipeline:

**CI (on push/PR):**
```yaml
jobs:
  lint:    # eslint + oxfmt check
  test:    # TZ=UTC vitest run
  build:   # tsdown build + publint
  dry-run: # npm pack --dry-run (verify publishable)
```

**Release (on tag push `v*`):**
```yaml
jobs:
  publish:
    # npm publish with --provenance (OIDC auth, no stored tokens)
    # changelogithub for release notes
```

**Key tools:**
| Tool | Purpose | Version |
|------|---------|---------|
| `bumpp` | Interactive version bumping (`bumpp -r` for monorepo) | latest |
| `changelogithub` | Auto-generate GitHub Release notes from conventional commits | latest |
| `clean-pkg-json` | Strip dev fields from package.json before publish | ^1.3.0 |
| `only-allow` | Enforce pnpm usage (`npx only-allow pnpm` in preinstall) | latest |

**npm provenance:** Use GitHub Actions OIDC (no `NPM_TOKEN` secret needed). Requires `permissions: id-token: write` in workflow.

**Confidence:** HIGH -- ccusage's exact workflow, well-documented on GitHub.

### 6. Linting & Formatting

**Status:** Not decided.
**Recommendation:**

| Tool | Purpose | Why |
|------|---------|-----|
| **eslint** 9.x + flat config | Linting | ccusage pattern. Flat config is the current standard. |
| **oxfmt** | Formatting | ccusage uses `.oxfmtrc.jsonc`. 30x faster than Prettier, 100% Prettier-compatible for JS/TS. Rust-based. |

Do NOT use Prettier -- oxfmt is faster, produces identical output, and is what ccusage uses.
Do NOT use Biome -- it bundles lint+format together, conflicting with the eslint+oxfmt split.

**Confidence:** HIGH -- oxfmt hit beta in Feb 2026, passes 100% of Prettier's JS/TS conformance tests.

### 7. JSONL Parsing Strategy

**Status:** Core feature, approach not specified.
**Recommendation:** Use Node.js built-in `node:readline` + `node:fs` -- no external streaming library needed.

```typescript
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import * as v from 'valibot';

// Line-by-line streaming, constant memory
const rl = createInterface({ input: createReadStream(filePath) });
for await (const line of rl) {
  const parsed = v.safeParse(SessionLineSchema, JSON.parse(line));
  if (!parsed.success) continue; // silent skip -- never throw
  // process parsed.output
}
```

**Why not stream-json or jsonl-parse?** They are external deps. JSONL is trivially parseable line-by-line with readline. ccusage does it this way. Zero deps is the constraint.

**Error handling:** Wrap `JSON.parse()` in try/catch, then `safeParse`. Both malformed JSON and schema-invalid lines silently skip. Use `@praha/byethrow` Result at the function boundary.

**Confidence:** HIGH -- this is exactly how ccusage and ccboard parse JSONL.

### 8. Package Manager Enforcement

**Status:** Not configured.
**Solution:**

```jsonc
// root package.json
{
  "scripts": {
    "preinstall": "npx only-allow pnpm"
  },
  "packageManager": "pnpm@10.30.1"
}
```

**Confidence:** HIGH -- standard pattern, ccusage uses it.

---

## Concerns / Alternatives Considered

### CLI Framework: gunshi vs. Alternatives

| Framework | Bundle Size | Type Safety | Subcommands | Why Not |
|-----------|-------------|-------------|-------------|---------|
| **gunshi** (chosen) | Tiny | Full TS inference | Lazy-loaded | -- |
| commander.js | Moderate | Manual typing | Eager | No type-safe args. 10x more code for same result. Overkill API surface. |
| yargs | Large | `@types/yargs` | Eager | Heavy bundle. Lots of runtime overhead. |
| cleye | Tiny | Good | Limited | Unmaintained. gunshi is its successor (same author ecosystem). |
| citty (UnJS) | Tiny | Good | Supported | Viable alternative, but gunshi has more features (i18n, plugins) and is what ccusage uses. Following the reference impl matters. |
| oclif | Large | Good | Built-in | Enterprise-grade, massive bundle. Wrong tool for a single-purpose CLI. |
| ink (React) | Large | TSX | Custom | Renders React to terminal. Insanely heavy for static table output. |

**Verdict:** gunshi is correct. It aligns with ccusage, bundles tiny, and has full type inference.

### Bundler: tsdown vs. Alternatives

| Bundler | Speed | Tree-shake | Shebang | Why Not |
|---------|-------|------------|---------|---------|
| **tsdown** (chosen) | Fastest (Rust) | Excellent | `outputOptions.banner` | -- |
| tsup | Fast (esbuild) | Good | Built-in `--shims` | Legacy predecessor. tsdown supersedes it. |
| unbuild | Fast | Good | Manual | Missing publint integration. |
| esbuild (raw) | Fast | Basic | Manual | No TS declaration support, more config needed. |
| rollup | Moderate | Excellent | Plugin | Slower, more complex config. |
| bun build | Fast | Limited | Manual | Tree-shaking inferior to tsdown. Not Rust-optimized for libraries. |

**Verdict:** tsdown is correct. Rust-based, best tree-shaking, ccusage-proven.

### Validation: valibot vs. Alternatives

| Library | Bundle Impact | Tree-shake | safeParse | Why Not |
|---------|--------------|------------|-----------|---------|
| **valibot** (chosen) | ~1KB per schema | Perfect | Native | -- |
| zod | ~13KB min | Poor | Native | Cannot tree-shake. 13x heavier than valibot for same schema. |
| ajv | ~30KB+ | Poor | Via compile | JSON Schema based, heavy runtime. |
| typebox | ~5KB | Moderate | Manual | Less ergonomic safeParse. |
| arktype | ~3KB | Good | Native | Newer, smaller community. Viable but valibot is ccusage-proven. |

**Verdict:** valibot is correct. Tree-shakable to individual function level, zero-dep, ccusage-proven.

### Result Type: @praha/byethrow vs. Alternatives

| Library | Bundle Impact | API Style | Tree-shake | Why Not |
|---------|--------------|-----------|------------|---------|
| **@praha/byethrow** (chosen) | ~2KB | FP (plain objects) | Perfect | -- |
| neverthrow | ~5KB | Class-based | Poor | Classes prevent tree-shaking. Heavier. |
| effect-ts | ~50KB+ | Full FP runtime | Overkill | Massive dependency for just Result. |
| fp-ts | ~20KB+ | Full FP | Moderate | Same problem. We need Result, not a category theory library. |
| ts-results | ~3KB | Rust-like | Moderate | Class-based, less tree-shakable. |
| Custom | 0 | Custom | Perfect | Viable but reinventing the wheel. byethrow already has ccusage integration patterns. |

**Verdict:** @praha/byethrow is correct. Lightweight FP approach, tree-shakable, ccusage-proven. Lower community adoption is the only concern (MEDIUM confidence vs HIGH for other choices).

### Table Rendering: cli-table3 vs. Alternatives

| Library | Maintained | Features | Types | Why Not |
|---------|------------|----------|-------|---------|
| **cli-table3** (chosen) | Yes | Full (spans, colors, wrap) | Built-in | -- |
| table | Yes | Similar | Built-in | Larger bundle, less adoption. |
| console-table-printer | Yes | Color-focused | Built-in | Less customizable layout. |
| columnify | Stale | Basic | External | Unmaintained. |

**Verdict:** cli-table3 is correct. Stable, widely adopted, sufficient features.

---

## Cross-Platform Notes

### Path Handling (CRITICAL)

ccaudit reads from `~/.claude/` and `~/.config/claude/` -- both use OS-specific home directory resolution.

**Rules:**
1. Always use `node:path` (`path.join`, `path.resolve`) -- never string concatenation with `/`.
2. Use `node:os` `homedir()` for `~` expansion -- do NOT rely on `$HOME` env var (unreliable on Windows).
3. Use `path.posix` methods when constructing glob patterns for tinyglobby -- globs always use forward slashes.
4. Windows: `~/.claude/` maps to `C:\Users\<user>\.claude\`. `path.join` handles this automatically.
5. JSONL file paths inside session data (the `cwd` field) may contain Windows backslashes -- normalize with `path.normalize()` before comparison.

### Windows-Specific Concerns

| Concern | Impact | Mitigation |
|---------|--------|------------|
| Path separators in globs | tinyglobby expects forward slashes | Use `path.posix.join` for glob patterns, `path.join` for fs operations |
| `~` expansion | No native `~` on Windows | `os.homedir()` handles this correctly |
| JSONL `cwd` field | May contain `\` on Windows | Normalize before path comparison |
| Shell emulation | npm scripts differ on Windows | pnpm `shellEmulator: true` in workspace config |
| Line endings | JSONL files use `\n` typically | `readline` handles both `\n` and `\r\n` |
| File permissions | `chmod +x` irrelevant on Windows | `bin` field + shebang handled by npm/pnpm |

### macOS / Linux

No special concerns. Both resolve `~` correctly via `os.homedir()`. Shebang `#!/usr/bin/env node` works natively.

---

## ccusage Patterns to Replicate

These are specific patterns from ccusage that ccaudit should copy verbatim:

### 1. Zero-Runtime-Deps Bundle Strategy

```
devDependencies: ALL libraries (gunshi, valibot, etc.)
dependencies: EMPTY
tsdown bundles everything into dist/index.js
Published package has zero install-time deps
```

This is enforced by:
- `clean-pkg-json` in prepack (strips devDependencies from published package.json)
- `publint: true` in tsdown config (validates package structure)
- No `dependencies` field in package.json

### 2. Entry Point Pattern

```typescript
// apps/ccaudit/src/index.ts
import { cli } from 'gunshi';
import { mainCommand } from './commands/index.js';

await cli(mainCommand);
```

Each subcommand is a separate file under `commands/`:
```
src/
  commands/
    index.ts       # mainCommand + subcommand union
    ghost.ts       # ccaudit ghost (default)
    inventory.ts   # ccaudit inventory
    mcp.ts         # ccaudit mcp
    trend.ts       # ccaudit trend
  index.ts         # CLI entry (shebang target)
```

### 3. Silent JSONL Skip Pattern

```typescript
// From ccusage: invalid lines silently skipped, never throw
for await (const line of rl) {
  try {
    const json = JSON.parse(line);
    const result = v.safeParse(schema, json);
    if (!result.success) continue;
    yield result.output;
  } catch {
    continue; // malformed JSON -- skip silently
  }
}
```

### 4. Workspace Internal Package References

```jsonc
// apps/ccaudit/package.json
{
  "devDependencies": {
    "@ccaudit/internal": "workspace:*",
    "@ccaudit/terminal": "workspace:*"
  }
}
```

Workspace packages are inlined by tsdown at build time -- they do NOT appear in the published package.

### 5. Test Runner with UTC Timezone

```jsonc
{
  "scripts": {
    "test": "TZ=UTC vitest"
  }
}
```

ccaudit's `--since` flag and trend analysis involve date comparisons. UTC-pinned tests prevent timezone-dependent failures.

### 6. Prepack Lifecycle

```jsonc
{
  "scripts": {
    "prepack": "pnpm run build && clean-pkg-json"
  }
}
```

This runs automatically before `npm publish` and `npm pack`:
1. Builds production bundle with tsdown
2. Strips dev-only fields from package.json

### 7. Release Flow

```
1. pnpm run prerelease        # Build all packages
2. pnpm bumpp -r              # Interactive version bump (all packages)
3. git push --follow-tags      # Push tag
4. GitHub Actions triggers     # On v* tag
5. npm publish --provenance    # OIDC auth, no stored tokens
6. npx changelogithub          # Generate release notes
```

### 8. Security Configuration (pnpm)

```yaml
# pnpm-workspace.yaml
strictDepBuilds: true         # Block postinstall scripts by default
blockExoticSubdeps: true      # Prevent exotic subdep attacks
minimumReleaseAge: 2880       # 48h quarantine for new releases
```

This is a supply-chain security pattern ccaudit should adopt.

---

## Installation Summary

```bash
# Core CLI deps (all as devDependencies)
pnpm add -D gunshi valibot tinyglobby cli-table3 @praha/byethrow

# Build tools
pnpm add -D tsdown vitest clean-pkg-json unplugin-unused

# Lint & Format
pnpm add -D eslint oxfmt

# Release tools
pnpm add -D bumpp changelogithub

# Types
pnpm add -D @types/node

# Package manager enforcement
pnpm add -D only-allow
```

All of these go into the root or workspace catalog. Individual `apps/*/package.json` files reference `catalog:` versions.

---

## What NOT to Use

| Library | Category | Why NOT |
|---------|----------|---------|
| commander.js | CLI | No type-safe args, larger bundle, wrong paradigm for subcommand CLI |
| yargs | CLI | Heavy, complex API surface, poor tree-shaking |
| ink | CLI UI | React-in-terminal is absurdly heavy for static tables |
| oclif | CLI framework | Enterprise framework, massive bundle, wrong tool for single-purpose CLI |
| Prettier | Formatter | oxfmt is 30x faster with identical output; ccusage uses oxfmt |
| Biome | Lint+Format | Monolithic; conflicts with eslint+oxfmt separation pattern |
| zod | Validation | Cannot tree-shake (13KB minimum vs valibot's ~1KB) |
| tsup | Bundler | Legacy predecessor to tsdown; slower, less tree-shaking |
| jest | Testing | Vitest is faster, supports in-source testing, better TS integration |
| neverthrow | Result type | Class-based, poor tree-shaking, heavier than byethrow |
| stream-json | JSONL parsing | External dep; `node:readline` handles JSONL trivially |
| chalk | Colors | cli-table3 handles ANSI colors internally; if standalone color needed, use `node:util.styleText` (Node 20+) or `picocolors` |

---

## Open Questions (for phase-specific research)

1. ~~**tsdown `define` for `import.meta.vitest` stripping**~~ **RESOLVED by code study**: Top-level `define` property. Confirmed from ccusage source.

2. ~~**gunshi subcommand lazy loading**~~ **RESOLVED by code study**: ccusage does NOT use lazy loading — all commands are imported eagerly. For ccaudit's 4-5 commands, eager loading is fine.

3. **Windows CI**: Should CI test on Windows? ccusage does not (uses Nix on ARM Ubuntu). Consider adding `windows-latest` to CI matrix given path handling concerns.

4. **Node.js minimum version**: ccusage targets Node 20+. ccaudit should match. `node:readline` async iterator is available since Node 18.

5. **Agent tool name `Task` vs `Agent`**: Code study found both names in different repos. Must support both. Need to verify which Claude Code versions use which name.

---

**Overall confidence:** HIGH

The stack is validated -- every component is actively maintained, proven in production by ccusage, and fits the zero-runtime-deps constraint. The primary gaps (CI pipeline, tsdown config, vitest config) are all solvable with documented patterns from ccusage. The only MEDIUM-confidence item is `@praha/byethrow` (smaller community), but it is ccusage-proven and functionally sound.

**Sources:**
- [ccusage repository](https://github.com/ryoppippi/ccusage)
- [ccusage DeepWiki](https://deepwiki.com/ryoppippi/ccusage)
- [ryoppippi's 2025 CLI stack blog](https://ryoppippi.com/blog/2025-08-12-my-js-cli-stack-2025-en)
- [gunshi docs](https://gunshi.dev/)
- [tsdown docs](https://tsdown.dev/guide/)
- [tsdown dependency handling](https://tsdown.dev/options/dependencies)
- [tsdown rolldown options](https://tsdown.dev/advanced/rolldown-options)
- [sitemcp tsdown.config.ts](https://github.com/ryoppippi/sitemcp/blob/main/tsdown.config.ts)
- [tsdown shebang discussion](https://github.com/rolldown/tsdown/discussions/589)
- [valibot safeParse docs](https://valibot.dev/api/safeParse/)
- [vitest in-source testing](https://vitest.dev/guide/in-source)
- [byethrow docs](https://praha-inc.github.io/byethrow/)
- [cli-table3 npm](https://www.npmjs.com/package/cli-table3)
- [tinyglobby npm](https://www.npmjs.com/package/tinyglobby)
- [pnpm catalogs](https://pnpm.io/catalogs)
- [oxfmt beta announcement](https://oxc.rs/blog/2026-02-24-oxfmt-beta)
- [clean-pkg-json](https://github.com/privatenumber/clean-pkg-json)
- [publint docs](https://publint.dev/docs/)

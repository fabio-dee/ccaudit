<!-- GSD:project-start source:PROJECT.md -->
## Project

**ccaudit**

`ccaudit` is a companion CLI to [ccusage](https://github.com/ryoppippi/ccusage) that audits Claude Code's ghost inventory — agents, skills, MCP servers, and memory files that load every session but are rarely or never invoked. It ships analysis-only in v1, adds a dry-run preview in v1.1, and delivers one-command remediation (`--dangerously-bust-ghosts`) with full rollback in v1.2. Zero runtime dependencies, zero-install via `npx`.

**Core Value:** Show users exactly how many tokens their ghost inventory wastes — and give them one safe, reversible command to reclaim them.

### Constraints

- **Runtime deps**: Zero — all deps as `devDependencies`, bundler owns the payload (ccusage pattern)
- **Distribution**: `npx ccaudit@latest` — zero-install, read-only v1 builds trust first
- **Tech stack**: TypeScript/Node · `gunshi` CLI · `tinyglobby` · `valibot` safeParse · `cli-table3` · `tsdown` · `vitest` in-source tests · `pnpm` workspaces
- **Monorepo layout**: `apps/ccaudit/` (main CLI), `apps/ccaudit-mcp/` (future), `packages/internal/` (shared types/utils), `packages/terminal/` (table rendering), `docs/` (VitePress)
- **Reversibility**: All remediation ops must be fully reversible — archive not delete, comment-out not delete, flag not move
- **Safety gate**: `--dangerously-bust-ghosts` blocked unless current dry-run checkpoint with matching hash exists
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Confirmed Stack (Validated)
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
## Gaps to Fill
### 1. Shebang Injection (tsdown config)
### 2. package.json `bin` Field
### 3. In-Source Testing (vitest config)
### 4. pnpm Catalog Configuration
# pnpm-workspace.yaml
### 5. CI/CD Pipeline (GitHub Actions)
| Tool | Purpose | Version |
|------|---------|---------|
| `bumpp` | Interactive version bumping (`bumpp -r` for monorepo) | latest |
| `changelogithub` | Auto-generate GitHub Release notes from conventional commits | latest |
| `clean-pkg-json` | Strip dev fields from package.json before publish | ^1.3.0 |
| `only-allow` | Enforce pnpm usage (`npx only-allow pnpm` in preinstall) | latest |
### 6. Linting & Formatting
| Tool | Purpose | Why |
|------|---------|-----|
| **eslint** 9.x + flat config | Linting | ccusage pattern. Flat config is the current standard. |
| **oxfmt** | Formatting | ccusage uses `.oxfmtrc.jsonc`. 30x faster than Prettier, 100% Prettier-compatible for JS/TS. Rust-based. |
### 7. JSONL Parsing Strategy
### 8. Package Manager Enforcement
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
### Bundler: tsdown vs. Alternatives
| Bundler | Speed | Tree-shake | Shebang | Why Not |
|---------|-------|------------|---------|---------|
| **tsdown** (chosen) | Fastest (Rust) | Excellent | `outputOptions.banner` | -- |
| tsup | Fast (esbuild) | Good | Built-in `--shims` | Legacy predecessor. tsdown supersedes it. |
| unbuild | Fast | Good | Manual | Missing publint integration. |
| esbuild (raw) | Fast | Basic | Manual | No TS declaration support, more config needed. |
| rollup | Moderate | Excellent | Plugin | Slower, more complex config. |
| bun build | Fast | Limited | Manual | Tree-shaking inferior to tsdown. Not Rust-optimized for libraries. |
### Validation: valibot vs. Alternatives
| Library | Bundle Impact | Tree-shake | safeParse | Why Not |
|---------|--------------|------------|-----------|---------|
| **valibot** (chosen) | ~1KB per schema | Perfect | Native | -- |
| zod | ~13KB min | Poor | Native | Cannot tree-shake. 13x heavier than valibot for same schema. |
| ajv | ~30KB+ | Poor | Via compile | JSON Schema based, heavy runtime. |
| typebox | ~5KB | Moderate | Manual | Less ergonomic safeParse. |
| arktype | ~3KB | Good | Native | Newer, smaller community. Viable but valibot is ccusage-proven. |
### Result Type: @praha/byethrow vs. Alternatives
| Library | Bundle Impact | API Style | Tree-shake | Why Not |
|---------|--------------|-----------|------------|---------|
| **@praha/byethrow** (chosen) | ~2KB | FP (plain objects) | Perfect | -- |
| neverthrow | ~5KB | Class-based | Poor | Classes prevent tree-shaking. Heavier. |
| effect-ts | ~50KB+ | Full FP runtime | Overkill | Massive dependency for just Result. |
| fp-ts | ~20KB+ | Full FP | Moderate | Same problem. We need Result, not a category theory library. |
| ts-results | ~3KB | Rust-like | Moderate | Class-based, less tree-shakable. |
| Custom | 0 | Custom | Perfect | Viable but reinventing the wheel. byethrow already has ccusage integration patterns. |
### Table Rendering: cli-table3 vs. Alternatives
| Library | Maintained | Features | Types | Why Not |
|---------|------------|----------|-------|---------|
| **cli-table3** (chosen) | Yes | Full (spans, colors, wrap) | Built-in | -- |
| table | Yes | Similar | Built-in | Larger bundle, less adoption. |
| console-table-printer | Yes | Color-focused | Built-in | Less customizable layout. |
| columnify | Stale | Basic | External | Unmaintained. |
## Cross-Platform Notes
### Path Handling (CRITICAL)
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
## ccusage Patterns to Replicate
### 1. Zero-Runtime-Deps Bundle Strategy
- `clean-pkg-json` in prepack (strips devDependencies from published package.json)
- `publint: true` in tsdown config (validates package structure)
- No `dependencies` field in package.json
### 2. Entry Point Pattern
### 3. Silent JSONL Skip Pattern
### 4. Workspace Internal Package References
### 5. Test Runner with UTC Timezone
### 6. Prepack Lifecycle
### 7. Release Flow
### 8. Security Configuration (pnpm)
# pnpm-workspace.yaml
## Installation Summary
# Core CLI deps (all as devDependencies)
# Build tools
# Lint & Format
# Release tools
# Types
# Package manager enforcement
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
## Open Questions (for phase-specific research)
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
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->

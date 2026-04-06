# Code Study: ccusage — Architecture to Replicate

## Executive Summary

ccusage is a production monorepo for analyzing Claude Code usage data. Structured as a pnpm workspace with multiple apps and shared libraries, zero-dependency bundling, in-source vitest tests, branded valibot types, Result<T> error handling via @praha/byethrow, and streaming JSONL parsing. **This is the primary reference architecture for ccaudit.**

---

## 1. Monorepo Structure

### Directory Layout
```
ccusage/
├── apps/
│   ├── ccusage/         # Main CLI tool (PRIMARY)
│   ├── codex/           # Secondary app
│   ├── mcp/             # MCP server
│   ├── amp/             # Analytics
│   ├── pi/              # Agent tool
│   └── opencode/        # Code analysis
├── packages/
│   ├── internal/        # @ccusage/internal (pricing, logger, format, constants)
│   └── terminal/        # @ccusage/terminal (table rendering)
├── docs/                # VitePress docs
├── pnpm-workspace.yaml
├── vitest.config.ts     # Root test config
└── .github/workflows/
```

### Workspace Configuration
**File**: `pnpm-workspace.yaml`

- Packages: `apps/*`, `docs`, `packages/*`
- Catalog mode: `strict` (all versions pinned in catalogs)
- Security: `strictDepBuilds: true`, `blockExoticSubdeps: true`, `trustPolicy: no-downgrade`
- Catalogs defined: `build`, `runtime`, `testing`, `docs`, `lint`, `llm-docs`, `release`

### Package References
**File**: `apps/ccusage/package.json`

```json
"devDependencies": {
  "@ccusage/internal": "workspace:*",
  "@ccusage/terminal": "workspace:*",
  "@praha/byethrow": "catalog:runtime",
  "gunshi": "catalog:runtime",
  "valibot": "catalog:runtime"
}
```

Internal package exports:
- `@ccusage/internal`: `./pricing`, `./pricing-fetch-utils`, `./logger`, `./format`, `./constants`
- `@ccusage/terminal`: `./table`, `./utils`

---

## 2. tsdown Config

**File**: `apps/ccusage/tsdown.config.ts`

```typescript
import { defineConfig } from 'tsdown';
import Macros from 'unplugin-macros/rolldown';

export default defineConfig({
  entry: ['./src/*.ts', '!./src/**/*.test.ts', '!./src/_*.ts'],
  outDir: 'dist',
  format: 'esm',                    // ESM only
  clean: true,
  sourcemap: false,
  minify: 'dce-only',               // Dead code elimination only
  treeshake: true,
  fixedExtension: false,
  dts: {
    tsgo: false,
    resolve: ['type-fest', 'valibot', '@ccusage/internal', '@ccusage/terminal'],
  },
  publint: true,                     // Validates package structure at build
  unused: true,
  exports: { devExports: true },
  nodeProtocol: true,
  plugins: [Macros({ include: ['src/index.ts', 'src/_pricing-fetcher.ts'] })],
  define: {
    'import.meta.vitest': 'undefined',  // Strip in-source tests
  },
});
```

**Key patterns**:
- Shebang: Not in tsdown config — handled in source file directly (`#!/usr/bin/env node`)
- Tree-shaking: `treeshake: true`
- Test stripping: `define: { 'import.meta.vitest': 'undefined' }`
- Output: ESM only (no CJS)
- Entry glob excludes `_*.ts` internal files and `*.test.ts`

---

## 3. package.json bin Field & npx Resolution

**File**: `apps/ccusage/package.json` (lines 29-47)

```json
"bin": {
  "ccusage": "./src/index.ts"
},
"publishConfig": {
  "bin": {
    "ccusage": "./dist/index.js"
  },
  "exports": {
    ".": "./dist/index.js",
    "./calculate-cost": "./dist/calculate-cost.js",
    "./data-loader": "./dist/data-loader.js"
  }
}
```

**Entry point**: `src/index.ts`
```typescript
#!/usr/bin/env node
import { run } from './commands/index.ts';
await run();
```

**How npx works**:
1. Development: `bin` points to `.ts` source (pnpm runs via tsx/node --loader)
2. Published: `publishConfig.bin` points to built `.js` in dist/
3. `npx ccusage` resolves to the published `.js` entry with shebang

---

## 4. Zero-Dep Bundling

### All deps as devDependencies
**File**: `apps/ccusage/package.json`

`"dependencies": {}` is **empty**. All runtime deps are in `devDependencies`.

### Prepack lifecycle
```json
"scripts": {
  "build": "pnpm run generate:schema && tsdown",
  "prepack": "pnpm run build && clean-pkg-json"
}
```

**What clean-pkg-json does**:
1. Transforms `devDependencies` → `dependencies` for runtime deps actually used
2. Strips dev-only fields (scripts, devDependencies listing)
3. Replaces `exports` with `publishConfig.exports`
4. Replaces `bin` with `publishConfig.bin`
5. Result: minimal published package.json with only needed runtime deps

**Source vs Published**:
- Source: `"bin": { "ccusage": "./src/index.ts" }`, all deps in devDependencies
- Published: `"bin": { "ccusage": "./dist/index.js" }`, runtime deps in dependencies

---

## 5. JSONL Parser

### Streaming Line-by-Line
**File**: `apps/ccusage/src/data-loader.ts` (lines 547-565)

```typescript
async function processJSONLFileByLine(
  filePath: string,
  processLine: (line: string, lineNumber: number) => void | Promise<void>,
): Promise<void> {
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Number.POSITIVE_INFINITY,  // Handles CRLF
  });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    if (line.trim().length === 0) continue;
    await processLine(line, lineNumber);
  }
}
```

### Malformed Line Handling
**File**: `apps/ccusage/src/data-loader.ts` (lines 804-811)

```typescript
await processJSONLFileByLine(file, async (line) => {
  try {
    const parsed = JSON.parse(line) as unknown;
    const result = v.safeParse(usageDataSchema, parsed);
    if (!result.success) {
      return;  // Silent skip — invalid schema
    }
    const data = result.output;
    // Process valid data
  } catch {
    // Silent skip — invalid JSON
  }
});
```

**Strategy**: `JSON.parse()` + `v.safeParse()` — double validation, silent skip on failure.

### Valibot Schemas
**File**: `apps/ccusage/src/data-loader.ts` (lines 160-220)

```typescript
export const usageDataSchema = v.object({
  timestamp: isoTimestampSchema,
  requestId: requestIdSchema,
  sessionId: sessionIdSchema,
  message: v.object({
    id: v.optional(messageIdSchema),
    model: v.optional(modelNameSchema),
    usage: v.object({
      input_tokens: v.number(),
      output_tokens: v.optional(v.number()),
      cache_creation_input_tokens: v.optional(v.number()),
      cache_read_input_tokens: v.optional(v.number()),
      speed: v.optional(v.enum(['fast', 'standard'])),
    }),
  }),
  costUSD: v.optional(v.number()),
});
```

### Branded Types
**File**: `apps/ccusage/src/_types.ts` (lines 7-132)

```typescript
export const modelNameSchema = v.pipe(
  v.string(),
  v.minLength(1, 'Model name cannot be empty'),
  v.brand('ModelName'),
);
export type ModelName = v.InferOutput<typeof modelNameSchema>;
export const createModelName = (value: string): ModelName => v.parse(modelNameSchema, value);
```

---

## 6. Dual Path Resolution

**File**: `apps/ccusage/src/_consts.ts` (lines 39-57)

```typescript
import { xdgConfig } from 'xdg-basedir';

const XDG_CONFIG_DIR = xdgConfig ?? path.join(USER_HOME_DIR, '.config');
export const DEFAULT_CLAUDE_CONFIG_PATH = path.join(XDG_CONFIG_DIR, 'claude');
export const DEFAULT_CLAUDE_CODE_PATH = '.claude';
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
```

**File**: `apps/ccusage/src/data-loader.ts` (lines 78-143)

```typescript
export function getClaudePaths(): string[] {
  const paths = [];
  const normalizedPaths = new Set<string>();

  // 1. Environment variable (supports comma-separated)
  const envPaths = (process.env[CLAUDE_CONFIG_DIR_ENV] ?? '').trim();
  if (envPaths !== '') {
    // Parse, validate, deduplicate
    return paths;
  }

  // 2. Default paths (only if no env var)
  const defaultPaths = [
    DEFAULT_CLAUDE_CONFIG_PATH,   // ~/.config/claude
    path.join(USER_HOME_DIR, DEFAULT_CLAUDE_CODE_PATH),  // ~/.claude
  ];

  for (const defaultPath of defaultPaths) {
    // Validate projects/ subdirectory exists, deduplicate
  }

  if (paths.length === 0) throw new Error('No valid Claude data directories found');
  return paths;
}
```

**Resolution order**: `CLAUDE_CONFIG_DIR` env → `~/.config/claude` (XDG) → `~/.claude` (legacy)

**Windows handling**: `apps/ccusage/src/data-loader.ts` (line 1135-1138)
```typescript
// Replace backslashes for tinyglobby compatibility
const patterns = claudePaths.map(p =>
  path.join(p, 'projects', '**', `${sessionId}.jsonl`).replace(/\\/g, '/')
);
```

---

## 7. CLI Framework Setup (gunshi)

### Command Router
**File**: `apps/ccusage/src/commands/index.ts` (lines 1-66)

```typescript
import { cli } from 'gunshi';

export const subCommandUnion = [
  ['daily', dailyCommand],
  ['monthly', monthlyCommand],
  ['weekly', weeklyCommand],
  ['session', sessionCommand],
  ['blocks', blocksCommand],
  ['statusline', statuslineCommand],
] as const;

const mainCommand = dailyCommand;  // Default

export async function run(): Promise<void> {
  let args = process.argv.slice(2);
  if (args[0] === 'ccusage') args = args.slice(1);  // Handle npx double-name

  await cli(args, mainCommand, {
    name, version, description, subCommands,
    renderHeader: null,
  });
}
```

### Command Definition
**File**: `apps/ccusage/src/commands/daily.ts` (lines 24-48)

```typescript
import { define } from 'gunshi';

export const dailyCommand = define({
  name: 'daily',
  description: 'Show usage report grouped by date',
  args: {
    since: { type: 'custom', short: 's', description: '...', parse: parseDateArg },
    until: { type: 'custom', short: 'u', description: '...', parse: parseDateArg },
    instances: { type: 'boolean', short: 'i', default: false },
    project: { type: 'string', short: 'p' },
    // ...
  },
  async run(ctx) {
    const config = loadConfig(ctx.values.config, ctx.values.debug);
    const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);
    // command implementation
  },
});
```

### Shared Args
**File**: `apps/ccusage/src/_shared-args.ts` (lines 19-113)

Common args: `since`, `until`, `json`, `mode`, `debug`, `order`, `breakdown`, `offline`, `color`, `noColor`, `timezone`, `locale`, `jq`, `config`, `compact`

**Lazy loading**: Not used — all commands imported eagerly.

---

## 8. @praha/byethrow Result Type

### Usage Pattern
**File**: `apps/ccusage/src/_utils.ts` (lines 14-22)

```typescript
export async function getFileModifiedTime(filePath: string): Promise<number> {
  return Result.pipe(
    Result.try({ try: stat(filePath), catch: (error) => error }),
    Result.map((stats) => stats.mtime.getTime()),
    Result.unwrap(0),  // Default to 0 if error
  );
}
```

**File**: `apps/ccusage/src/_jq-processor.ts` (lines 10-39)

```typescript
export async function processWithJq(jsonData, jqCommand): Result.ResultAsync<string, Error> {
  const result = Result.try({
    try: async () => { /* spawn jq */ },
    catch: (error) => {
      if (error.message.includes('ENOENT')) return new Error('jq not found');
      return new Error(`jq failed: ${error.message}`);
    },
  });
  return result();
}
```

### Pervasiveness
**Selective, not pervasive** — used for I/O operations and external command calls (file access, jq processing, config loading), not for business logic validation.

Files using Result: `data-loader.ts`, `commands/*.ts`, `_config-loader-tokens.ts`, `debug.ts`, `_jq-processor.ts`, `_utils.ts`

---

## 9. In-Source Tests

### Pattern
**File**: `apps/ccusage/src/_daily-grouping.ts` (lines 59-152)

```typescript
if (import.meta.vitest != null) {
  describe('groupByProject', () => {
    it('groups daily data by project for JSON output', () => {
      const mockData = [{ date: createDailyDate('2024-01-01'), ... }];
      const result = groupByProject(mockData);
      expect(Object.keys(result)).toHaveLength(2);
    });
  });
}
```

### Vitest Config (enables in-source)
**File**: `apps/ccusage/vitest.config.ts`

```typescript
export default defineConfig({
  test: {
    watch: false,
    includeSource: ['src/**/*.{js,ts}'],  // KEY: enables in-source test discovery
    globals: true,
  },
});
```

### Root Config (workspace-level)
**File**: `vitest.config.ts`

```typescript
export default defineConfig({
  test: {
    passWithNoTests: true,
    watch: false,
    reporters: isGitHubActions ? ['default', 'github-actions'] : ['default'],
    projects: ['apps/*/vitest.config.ts', 'packages/*/vitest.config.ts'],
  },
});
```

### Build-Time Stripping
`define: { 'import.meta.vitest': 'undefined' }` in tsdown config → DCE removes all test blocks from published bundle.

---

## 10. CI Pipeline

### CI Workflow
**File**: `.github/workflows/ci.yaml`

Jobs (all on `ubuntu-24.04-arm`):
1. **lint-check**: `pnpm lint` + `pnpm typecheck`
2. **test**: Creates Claude directories → `pnpm run test`
3. **npm-publish-dry-run**: `pnpm pkg-pr-new publish` (PR preview releases)
4. **spell-check**: `typos --config ./typos.toml`
5. **schema-check**: Generate + diff schema files

Uses Nix for dev environment (`nix develop --command`).

### Release Workflow
**File**: `.github/workflows/release.yaml`

Triggered by: push tags (any pattern)
1. **npm**: `pnpm --filter='./apps/**' publish --provenance --no-git-checks --access public`
2. **release**: `pnpm changelogithub` (creates GitHub Release from commits)

**Release flow**: `bumpp` (local version bump) → push tag → CI publishes to npm + creates GitHub Release

---

## 11. ResponsiveTable (Terminal Rendering)

**File**: `packages/terminal/src/table.ts` (lines 87-298)

```typescript
export class ResponsiveTable {
  private head: string[];
  private rows: TableRow[] = [];
  private compactHead?: string[];
  private compactThreshold: number;
  private compactMode = false;

  constructor(options: TableOptions) {
    this.compactThreshold = options.compactThreshold ?? 100;
    this.forceCompact = options.forceCompact ?? false;
  }

  toString(): string {
    const terminalWidth = parseInt(process.env.COLUMNS ?? '', 10)
      || process.stdout.columns || 120;

    // Determine compact mode
    this.compactMode = this.forceCompact
      || (terminalWidth < this.compactThreshold && this.compactHead != null);

    // Calculate column widths (uses string-width for wide chars)
    // Apply responsive resizing if table doesn't fit
    if (totalRequiredWidth > terminalWidth) {
      const scaleFactor = availableWidth / columnWidths.reduce(...);
      // Scale columns proportionally, enforce minimums
    }

    const table = new Table({ head, colAligns, colWidths, wordWrap: true });
    // ... render with cli-table3
  }
}
```

**Key features**:
- Terminal-width-aware rendering
- Compact mode with alternate headers when narrow
- `string-width` for proper CJK/emoji width handling
- `cli-table3` for actual table rendering with alignment, borders, word wrap

**Color library**: `picocolors` (minimal, auto-detects NO_COLOR/FORCE_COLOR)

---

## 12. Error Handling & Exit Codes

| Exit Code | Meaning | Trigger |
|-----------|---------|---------|
| 0 | Success | Data found and displayed, or no data (graceful) |
| 1 | Error | jq failure, config error, parsing error |

**Graceful degradation**: Missing files logged at debug level, execution continues. No data = exit 0 with warning message.

---

## 13. Additional Notable Patterns

### Config Loading
Search order: `./.ccusage/ccusage.json` → `<claude-config-dir>/ccusage.json`
CLI args override config file.

### Build-Time Macros
```typescript
import { prefetchClaudePricing } from './_macro.ts' with { type: 'macro' };
const PREFETCHED_CLAUDE_PRICING = prefetchClaudePricing();
```
`unplugin-macros` embeds pricing data at build time.

### Logger
`consola` with `LOG_LEVEL` env var control.

---

## 14. Patterns to Replicate in ccaudit

### Must Replicate Verbatim
1. **Monorepo layout**: `apps/ccaudit/`, `packages/internal/`, `packages/terminal/`
2. **pnpm catalogs**: Strict mode with named catalogs (build, runtime, testing, etc.)
3. **Zero-dep bundling**: All deps in devDependencies + clean-pkg-json prepack
4. **tsdown config**: ESM, treeshake, publint, `import.meta.vitest` stripping
5. **publishConfig pattern**: Source `bin`/`exports` for dev, published versions for dist
6. **JSONL streaming**: `createReadStream` + `readline.createInterface` + `for await`
7. **Malformed line handling**: `JSON.parse()` + `v.safeParse()` silent skip
8. **Dual path resolution**: `CLAUDE_CONFIG_DIR` env → XDG → legacy `~/.claude`
9. **In-source tests**: `if (import.meta.vitest != null)` + vitest `includeSource`
10. **Branded valibot types**: Type-safe strings with `v.brand()`

### Adapt (Same Pattern, Different Details)
1. **gunshi commands**: `define()` + `cli()` with subcommands — our commands differ
2. **Shared args**: `--since`, `--json`, `--debug` etc. — different flags for ccaudit
3. **ResponsiveTable**: We need different columns but same responsive approach
4. **Result type**: Use for I/O and external calls, not business logic

### Skip (Not Relevant)
1. **Macros**: No build-time data embedding needed
2. **Pricing fetcher**: ccaudit doesn't calculate costs
3. **Multiple date grouping commands**: ccaudit has different subcommands

# Code Study Synthesis

**Date:** 2026-04-03
**Repos studied:** 8 (ccusage, ccboard, who-ran-what, agent-usage-analyzer, claude-code-trace, cc-trace, Agent-Registry, claude-code-transcripts)
**Method:** Direct source code reading — no web searches, no DeepWiki

---

## 1. Validation of Existing Research Documents

### STACK.md — Validated, Minor Corrections Needed

| Claim | Verdict | Evidence |
|-------|---------|---------|
| Monorepo layout matches ccusage | **CONFIRMED** | ccusage has `apps/`, `packages/internal/`, `packages/terminal/`, `docs/` — exact match |
| Zero-dep bundling via devDependencies + clean-pkg-json | **CONFIRMED** | ccusage `package.json` has empty `dependencies`, all in `devDependencies`, `prepack` runs `clean-pkg-json` |
| tsdown with `outputOptions.banner` for shebang | **CORRECTION** | ccusage does NOT use `outputOptions.banner` for shebang. The shebang is in the source file itself (`#!/usr/bin/env node` at top of `src/index.ts`). tsdown preserves it. The `outputOptions.banner` approach (from sitemcp) works but isn't what ccusage does. |
| `inputOptions.define` for vitest stripping | **CORRECTION** | ccusage uses top-level `define: { 'import.meta.vitest': 'undefined' }` in tsdown config, not `inputOptions.define`. This resolves the MEDIUM confidence gap in STACK.md. |
| `publishConfig` pattern for bin/exports | **NEW FINDING** | ccusage uses a dual `bin`/`publishConfig.bin` pattern not mentioned in STACK.md: source `bin` points to `.ts`, published `bin` points to `.js`. This is how dev `pnpm run` works with TypeScript directly while `npx` gets the built JS. |
| pnpm catalogs with named groups | **CONFIRMED** | ccusage uses named catalogs: `build`, `runtime`, `testing`, `docs`, `lint`, `llm-docs`, `release` |
| gunshi command definition via `define()` | **CONFIRMED** | Exact pattern: `export const dailyCommand = define({ name, description, args, run(ctx) })` |
| valibot branded types | **CONFIRMED** | `v.pipe(v.string(), v.minLength(1), v.brand('ModelName'))` pattern used throughout |
| @praha/byethrow selective usage | **CONFIRMED** | Used for I/O and external calls only (file ops, jq processing), not business logic. Pattern: `Result.pipe(Result.try(...), Result.map(...), Result.unwrap(default))` |
| picocolors for terminal colors | **NEW FINDING** | Not in STACK.md. ccusage uses `picocolors` (not chalk) for standalone color. cli-table3 handles ANSI in tables but `picocolors` is used for non-table output. |
| consola for logging | **NEW FINDING** | Not in STACK.md. ccusage uses `consola` with `LOG_LEVEL` env var. Should add to stack. |
| unplugin-macros for build-time computation | **NEW FINDING** | ccusage embeds pricing data at build time via macros. Not relevant for ccaudit but good to know. |
| Nix for CI dev environment | **NEW FINDING** | ccusage CI uses `nix develop --command` for all jobs. We can use simpler setup. |

### ARCHITECTURE.md — Validated, All Correct

| Claim | Verdict | Evidence |
|-------|---------|---------|
| `message.content[].type === 'tool_use'` for extraction | **CONFIRMED** | All 5 repos that parse JSONL agree: filter assistant messages, scan content array for tool_use blocks |
| Agent: `name === 'Agent'` → `input.subagent_type` | **CORRECTION** | ccusage uses `name === 'Task'` not `name === 'Agent'` — but our local JSONL inspection showed `name === 'Agent'`. Both may exist. who-ran-what uses `"name":"Task"`. ccboard uses `"name":"Task"`. **Need to support BOTH `Agent` and `Task` as the tool name.** |
| Skill: `name === 'Skill'` → `input.skill` | **CONFIRMED** | All repos agree on this exact pattern |
| MCP: `mcp__<server>__<tool>` prefix | **CONFIRMED** | All repos (Rust, Go, TypeScript, Bash) confirm double-underscore prefix and separator |
| MCP split: strip `mcp__`, split on next `__` | **CONFIRMED** | claude-code-trace Rust: `strip_prefix("mcp__") → find("__") → split`. ccboard: same logic. |
| Silent skip for malformed JSONL | **CONFIRMED** | ccusage, ccboard, claude-code-transcripts all use skip-and-continue |
| Dual path: XDG + legacy | **CONFIRMED** | ccusage checks `CLAUDE_CONFIG_DIR` → `~/.config/claude` → `~/.claude` with dedup |
| Streaming readline for JSONL | **CONFIRMED** | ccusage: `createReadStream` + `createInterface` + `for await` |
| InvocationLedger data structure | **CONFIRMED** | ccboard's `PluginUsage` has same fields: name, invocationCount, sessionsUsed, firstSeen, lastSeen |

### FEATURES.md — Validated, No Changes Needed

All feature assessments hold. Code study confirms:
- who-ran-what's `wr clean` is limited (hardcoded agent list, project-only skills, no MCP, no token cost) — our differentiators are real
- ccboard has dead code detection + token attribution per tool — closer competitor than documented, but no remediation
- Agent-Registry has archive but no usage analysis — confirms our unique position combining analysis + remediation

### PITFALLS.md — Validated, Refinements

| Pitfall | Verdict | Evidence |
|---------|---------|---------|
| C1: MCP in wrong file | **CONFIRMED** | All repos read from `~/.claude/projects/` JSONL, none read MCP from settings.json |
| C2: JSON comments impossible | **CONFIRMED** | No repo attempts JSON comments. Agent-Registry uses key-based archival pattern |
| H1: False positive ghosts | **CONFIRMED** | who-ran-what has this exact problem (hardcoded 30d window, no lastUsed dates) |
| H3: JSONL schema evolution | **CONFIRMED** | ccboard uses circuit breaker (MAX_SCAN_LINES: 10,000, MAX_LINE_SIZE: 10MB) — we should too |
| L3: MCP name edge cases | **CONFIRMED** | claude-code-trace splits on first `__` after prefix, then next `__` — handles servers with embedded `__` correctly |
| M2: Subagent sessions | **CONFIRMED** | claude-code-transcripts explicitly filters `subagents/` subdirectory |

**New pitfall from code study**: ccboard tracks `parent_session_id` and `has_subagents` — we should parse these fields to correctly attribute subagent tool usage to the parent session's project context.

---

## 2. Discrepancies: DeepWiki/Web Research vs Actual Code

### Discrepancy 1: Agent Tool Name — `Task` vs `Agent`

**Web research said:** Tool name is `Agent` with `input.subagent_type`
**Code says:** who-ran-what and ccboard both grep for `"name":"Task"`. Our own JSONL inspection found `"name":"Agent"`.

**Resolution:** Claude Code likely changed the tool name from `Task` to `Agent` at some point. The older repos (who-ran-what, ccboard) still use `Task`. **ccaudit must detect BOTH `Task` and `Agent` tool names** to handle sessions from different Claude Code versions.

### Discrepancy 2: tsdown Shebang Injection

**Web research said:** Use `outputOptions.banner` for shebang (from sitemcp reference)
**Code says:** ccusage puts `#!/usr/bin/env node` directly in the source file (`src/index.ts` line 1). tsdown preserves it in output.

**Resolution:** Both approaches work. Source-file shebang is simpler. Use ccusage's approach (shebang in source).

### Discrepancy 3: tsdown `define` Config Location

**STACK.md said (MEDIUM confidence):** `inputOptions.define` or `rolldownOptions.define`
**Code says:** Top-level `define` property in tsdown config: `define: { 'import.meta.vitest': 'undefined' }`

**Resolution:** The correct syntax is top-level `define`. STACK.md gap resolved — confidence upgraded to HIGH.

### Discrepancy 4: Lazy Loading in gunshi

**Web research said:** gunshi supports lazy-loaded subcommands
**Code says:** ccusage imports ALL commands eagerly: `import { dailyCommand } from './daily.ts'` etc. The `subCommands` map is populated at module load time.

**Resolution:** Lazy loading may be supported but ccusage doesn't use it. For ccaudit's 4-5 commands, eager loading is fine. Skip lazy loading complexity.

### Discrepancy 5: byethrow Pervasiveness

**STACK.md said:** "battle-tested in ccusage"
**Code says:** Used selectively for I/O operations only. Most business logic uses plain TypeScript without Result wrapping.

**Resolution:** Don't over-use byethrow. Reserve for file I/O, external processes, and config loading boundaries. Use plain throws/returns for internal logic.

---

## 3. Concrete Code Patterns to Replicate from ccusage

### Pattern 1: tsdown.config.ts
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
    'import.meta.vitest': 'undefined',
  },
});
```
**Source**: `apps/ccusage/tsdown.config.ts`

### Pattern 2: package.json with publishConfig
```jsonc
{
  "name": "ccaudit",
  "type": "module",
  "bin": { "ccaudit": "./src/index.ts" },
  "publishConfig": {
    "bin": { "ccaudit": "./dist/index.js" },
    "exports": { ".": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsdown",
    "test": "TZ=UTC vitest",
    "prepack": "pnpm run build && clean-pkg-json"
  },
  "devDependencies": { /* all deps here */ },
  "dependencies": {}
}
```
**Source**: `apps/ccusage/package.json`

### Pattern 3: CLI Entry Point
```typescript
// src/index.ts
#!/usr/bin/env node
import { run } from './commands/index.ts';
await run();
```
**Source**: `apps/ccusage/src/index.ts`

### Pattern 4: gunshi Command Router
```typescript
// src/commands/index.ts
import { cli } from 'gunshi';

export const subCommandUnion = [
  ['ghost', ghostCommand],
  ['inventory', inventoryCommand],
  ['mcp', mcpCommand],
  ['trend', trendCommand],
] as const;

const mainCommand = ghostCommand; // default

export async function run(): Promise<void> {
  let args = process.argv.slice(2);
  if (args[0] === 'ccaudit') args = args.slice(1);
  await cli(args, mainCommand, { name, version, description, subCommands });
}
```
**Source**: `apps/ccusage/src/commands/index.ts`

### Pattern 5: gunshi Command Definition
```typescript
import { define } from 'gunshi';

export const ghostCommand = define({
  name: 'ghost',
  description: 'Show ghost inventory report',
  args: {
    since: { type: 'custom', short: 's', parse: parseDateArg },
    json: { type: 'boolean', short: 'j', default: false },
    ci: { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    quiet: { type: 'boolean', short: 'q', default: false },
  },
  async run(ctx) { /* implementation */ },
});
```
**Source**: `apps/ccusage/src/commands/daily.ts`

### Pattern 6: JSONL Streaming Parser
```typescript
async function* parseSessionFile(filePath: string): AsyncGenerator<SessionLine> {
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      const result = v.safeParse(sessionLineSchema, parsed);
      if (!result.success) continue;
      yield result.output;
    } catch { continue; }
  }
}
```
**Source**: `apps/ccusage/src/data-loader.ts` lines 547-565, 804-811

### Pattern 7: Dual Path Resolution
```typescript
export function getClaudePaths(): string[] {
  const envPaths = (process.env.CLAUDE_CONFIG_DIR ?? '').trim();
  if (envPaths !== '') {
    // Parse comma-separated, validate, return
  }
  // Default: check both XDG and legacy
  const defaults = [
    path.join(xdgConfig ?? path.join(homedir(), '.config'), 'claude'),
    path.join(homedir(), '.claude'),
  ];
  // Validate projects/ subdir exists, deduplicate
}
```
**Source**: `apps/ccusage/src/data-loader.ts` lines 78-143

### Pattern 8: vitest.config.ts (enables in-source tests)
```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    watch: false,
    includeSource: ['src/**/*.{js,ts}'],
    globals: true,
  },
});
```
**Source**: `apps/ccusage/vitest.config.ts`

### Pattern 9: In-Source Test
```typescript
// At bottom of any source file:
if (import.meta.vitest != null) {
  const { describe, it, expect } = import.meta.vitest;
  describe('functionName', () => {
    it('should do something', () => {
      expect(functionName(input)).toEqual(expected);
    });
  });
}
```
**Source**: `apps/ccusage/src/_daily-grouping.ts` lines 59-152

### Pattern 10: ResponsiveTable
```typescript
const table = new ResponsiveTable({
  head: ['Category', 'Name', 'Status', 'Last Used', '~Tokens'],
  colAligns: ['left', 'left', 'left', 'right', 'right'],
  compactHead: ['Cat', 'Name', 'Status', '~Tok'],
  compactThreshold: 100,
});
table.push(['Agent', 'Explore', 'GHOST', '2026-03-01', '~1,200']);
console.log(table.toString());
```
**Source**: `packages/terminal/src/table.ts`

---

## 4. JSONL Parsing Patterns from ccboard/who-ran-what

### Pattern A: 5-Type Classification (from ccboard)
```typescript
type PluginType = 'skill' | 'command' | 'agent' | 'mcpServer' | 'nativeTool';

function classifyTool(name: string, skills: string[], commands: string[]): PluginType {
  if (name.startsWith('mcp__')) return 'mcpServer';
  if (name === 'Task' || name === 'Agent') return 'agent';
  if (skills.includes(name.toLowerCase())) return 'skill';
  if (commands.includes(name)) return 'command';
  return 'nativeTool';
}
```
**Source**: `ccboard/crates/ccboard-core/src/analytics/plugin_usage.rs` lines 158-217

### Pattern B: Proportional Token Distribution (from ccboard)
When multiple tools appear in the same assistant message, distribute the message's token count proportionally:
```typescript
const toolsInMessage = contentBlocks.filter(b => b.type === 'tool_use');
const tokensPerTool = Math.floor(messageTokens / toolsInMessage.length);
```
**Source**: `ccboard/crates/ccboard-core/src/parsers/session_index.rs` lines 438-520

### Pattern C: Set Difference for Ghost Detection (from who-ran-what)
```typescript
const installed = new Set(discoveredAgents.map(a => a.name));
const used = new Set(invocationLedger.agents.keys());
const ghosts = [...installed].filter(name => !used.has(name));
```
**Source**: `who-ran-what/lib/who-ran-what/core/claude-parser.sh` lines 298-319

### Pattern D: MCP Server+Tool Split (from claude-code-trace)
```typescript
function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5); // strip 'mcp__'
  const idx = rest.indexOf('__');
  if (idx === -1) return null;
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}
```
**Source**: `claude-code-trace/src-tauri/src/parser/taxonomy.rs` lines 50-61

### Pattern E: File Size Protection (from ccboard)
```typescript
const MAX_LINE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_SCAN_LINES = 10_000;

// Skip oversized lines, circuit-break on too many lines
```
**Source**: `ccboard/crates/ccboard-core/src/parsers/session_index.rs`

---

## 5. Archive Patterns from Agent-Registry

### Pattern: Non-Destructive Default, Destructive Opt-In
- Default: copy files to archive, leave originals
- Destructive: explicit `--move` flag required
- ccaudit equivalent: `--dangerously-bust-ghosts` is the opt-in

### Pattern: Manifest-Based Archive
```json
{
  "version": 1,
  "generated_at": "ISO timestamp",
  "items": [{
    "name": "agent-name",
    "original_path": "~/.claude/agents/agent.md",
    "archive_path": ".ccaudit-archive/agents/agent.md",
    "content_hash": "8-char-md5",
    "token_estimate": 1850
  }]
}
```
**Improved from Agent-Registry**: Add `original_path` for restore, `content_hash` for validation.

### Pattern: Path Traversal Protection
```typescript
function resolveArchivePath(itemPath: string): { ok: true; path: string } | { ok: false; error: string } {
  const resolved = path.resolve(archiveDir, itemPath);
  if (!resolved.startsWith(archiveDir)) {
    return { ok: false, error: `Refusing to access path outside archive: ${itemPath}` };
  }
  return { ok: true, path: resolved };
}
```
**Source**: `Agent-Registry/lib/registry.js` lines 30-56

### Pattern: Token Estimation
```typescript
const tokenEstimate = Math.floor(content.length / 4);
```
Simple but effective. Agent-Registry uses this, ccboard uses proportional distribution from usage data. **ccaudit should use both**: `content.length / 4` for the estimate column, actual invocation token data from JSONL for measured values.

---

## 6. Requirements Updates from Code Study

### New Requirements to Add

1. **Support both `Task` and `Agent` tool names** — Claude Code changed the tool name. Both appear in real JSONL files. Detection must handle both.

2. **File size protection** — Add MAX_LINE_SIZE (10MB) and MAX_SCAN_LINES (10,000) circuit breakers to JSONL parser, following ccboard's pattern.

3. **`parent_session_id` tracking** — ccboard tracks subagent parent relationships. We should parse `parentUuid`/`parent_session_id` to correctly attribute subagent tool usage.

4. **`picocolors` for non-table color output** — ccusage uses this. Add to stack for progress indicators, warnings, etc.

### Corrections to Existing Plans

1. **Shebang approach**: Use source-file shebang (`#!/usr/bin/env node` in `src/index.ts`) instead of `outputOptions.banner`. This is what ccusage actually does.

2. **tsdown `define` config**: Use top-level `define` property, not `inputOptions.define`. Confidence upgraded from MEDIUM to HIGH.

3. **publishConfig pattern**: Add dual `bin`/`publishConfig.bin` pattern to package.json design. Source `bin` points to `.ts` for dev, published `bin` points to `.js`.

4. **Agent tool name**: Architecture must handle both `name === 'Agent'` AND `name === 'Task'` — not just one.

---

## 7. Summary: What Each Repo Taught Us

| Repo | Key Contribution | Confidence |
|------|------------------|-----------|
| **ccusage** | Complete architecture reference — monorepo, tsdown, gunshi, valibot, vitest, zero-dep bundling, dual path resolution, streaming JSONL | HIGH |
| **ccboard** | 5-type tool classification, proportional token distribution, file size protection, first/last seen timestamps, dead code detection | HIGH |
| **who-ran-what** | Set-difference ghost detection, allowlist pattern (unfinished but useful design), limitations to avoid (hardcoded lists, no MCP, no token cost) | HIGH |
| **agent-usage-analyzer** | Canonical key format (`kind:name`), alias resolution, coverage reporting, MCP normalization (`__` → `/`), partial session tracking | MEDIUM |
| **claude-code-trace** | MCP split logic confirmed (Rust), JSONL entry structure, tool_use block extraction | HIGH |
| **cc-trace** | Hook event schemas (PostToolUse, SubagentStop), fields available in hooks but not JSONL | MEDIUM |
| **Agent-Registry** | Archive manifest pattern, path traversal protection, token estimation (`content.length/4`), non-destructive default | HIGH |
| **claude-code-transcripts** | Dual-format content handling (string|array), skip-and-continue error handling, subagent directory filtering | LOW (but confirms patterns) |

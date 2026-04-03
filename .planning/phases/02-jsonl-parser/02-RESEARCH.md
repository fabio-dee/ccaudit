# Phase 2: JSONL Parser - Research

**Researched:** 2026-04-03
**Domain:** JSONL parsing, file discovery, schema validation, invocation extraction
**Confidence:** HIGH

## Summary

Phase 2 transforms raw Claude Code session JSONL files into a structured invocation ledger. This requires three distinct capabilities: (1) discovering session files across dual paths (XDG + legacy) including subagent subdirectories, (2) streaming line-by-line parsing with schema validation and silent error handling, and (3) extracting Agent, Skill, and MCP tool invocations from `tool_use` blocks in assistant messages.

The research draws on firsthand inspection of real JSONL files on this machine (4,567 files across 88 projects, largest ~60MB), validated code patterns from 8 reference implementations (ccusage, ccboard, who-ran-what, agent-usage-analyzer, claude-code-trace, cc-trace, Agent-Registry, claude-code-transcripts), and the project's confirmed stack (valibot, tinyglobby, byethrow, node:readline).

**Primary recommendation:** Build three modules -- `discover.ts` (file discovery via tinyglobby), `parse-session.ts` (streaming JSONL parser with valibot schemas), and `extract-invocations.ts` (tool_use block classification into Agent/Skill/MCP records). Use `node:readline` with `createReadStream` for constant-memory streaming. Use valibot `safeParse` for double-validation (JSON.parse + schema). Use byethrow `Result` at module boundaries only.

**Critical path correction:** The requirements document specifies `~/.claude/projects/*/sessions/*.jsonl` as the session file path. **This is incorrect.** Real session files live at `~/.claude/projects/<encoded-path>/<session-uuid>.jsonl` -- there is NO `sessions/` subdirectory. The glob pattern must be `~/.claude/projects/*/*.jsonl` (and `~/.config/claude/projects/*/*.jsonl` for XDG). Subagent files are at `~/.claude/projects/*/<session-uuid>/subagents/agent-*.jsonl`.

## Project Constraints (from CLAUDE.md)

CLAUDE.md enforces these directives that constrain this phase:

- **Zero runtime deps**: All libraries (valibot, tinyglobby, byethrow) are devDependencies; tsdown bundles them
- **Tech stack locked**: TypeScript/Node >= 20, valibot safeParse, tinyglobby, @praha/byethrow, vitest in-source tests
- **Distribution**: `npx ccaudit@latest` -- zero install
- **Safety**: Malformed JSONL lines silently skipped -- parser never throws on corrupt data (DIST-04)
- **GSD workflow**: Must not make direct repo edits outside GSD workflow
- **Monorepo layout**: `apps/ccaudit/` for CLI, `packages/internal/` for shared types/utils
- **In-source testing**: `if (import.meta.vitest)` blocks, vitest `includeSource`
- **Cross-platform**: `path.posix.join` for glob patterns, `path.join` for fs, `os.homedir()` for `~`

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PARS-01 | Session files discovered from `~/.claude/projects/*/sessions/*.jsonl` and `~/.config/claude/projects/*/sessions/*.jsonl` | **PATH CORRECTION NEEDED**: Real path is `projects/*/*.jsonl` not `projects/*/sessions/*.jsonl`. tinyglobby `glob()` with `absolute: true` and dual-path patterns. See Architecture > Session Discovery. |
| PARS-02 | Subagent sessions (`isSidechain: true`, in `subagents/` subdir) included in invocation count | Subagent files at `projects/*/*/subagents/agent-*.jsonl`. `isSidechain: true` confirmed on all lines. Same `sessionId` as parent. See JSONL Schema Findings > Subagent Structure. |
| PARS-03 | Agent invocations parsed from `type=assistant` `tool_use` blocks where `name='Agent'`; `input.subagent_type` = agent type | Confirmed from real data. Also must support `name='Task'` (older Claude Code versions). See JSONL Schema Findings > Tool Invocation Detection. |
| PARS-04 | Skill invocations parsed from `tool_use` blocks where `name='Skill'`; `input.skill` = skill name | Confirmed: `{type:"tool_use", name:"Skill", input:{skill:"gsd:plan-phase", args:"1"}}`. See JSONL Schema Findings. |
| PARS-05 | MCP invocations parsed from `tool_use` blocks where name matches `mcp__<server>__<tool>` | Confirmed: `{type:"tool_use", name:"mcp__Claude_in_Chrome__tabs_context_mcp"}`. Split on `__` after stripping `mcp__` prefix. See Code Examples > MCP Parser. |
| PARS-06 | Project path resolved from `cwd` field in system messages | `cwd` present on ALL message types (user, assistant, system), not just system. First `cwd` value in the file is authoritative. See JSONL Schema Findings > CWD Resolution. |
| PARS-07 | `--since <duration>` flag on all read commands with configurable lookback (default: 7d) | Parse duration string (`7d`, `30d`, `1w`) into ms offset. Filter sessions by `timestamp` field (ISO 8601). gunshi `type: 'custom'` with `parse` function. See Architecture > Time Window Filtering. |
</phase_requirements>

## Standard Stack

### Core (Phase 2 specific)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:readline` | Node 20+ built-in | Line-by-line JSONL streaming | Handles CRLF, constant memory, async iterator. No external dep needed. |
| `node:fs` | Node 20+ built-in | `createReadStream` for file streaming | Standard, no dep. |
| `node:path` | Node 20+ built-in | Cross-platform path operations | `path.join` for fs, `path.posix.join` for globs |
| `node:os` | Node 20+ built-in | `homedir()` for `~` expansion | Works on all platforms including Windows |
| `valibot` | ^1.3.1 | JSONL line schema validation via `safeParse` | Tree-shakable (~1KB per schema), ccusage-proven, zero deps |
| `tinyglobby` | ^0.2.15 | Session file discovery | 2 subdeps vs globby's 23, async `glob()` with ignore/absolute options |
| `@praha/byethrow` | ^0.10.1 | Result type at module boundaries | ccusage pattern: I/O boundaries only, not business logic |
| `gunshi` | ^0.29.3 | CLI `--since` arg with `type: 'custom'` | Already used for ghost command; `parse` function for duration strings |

### Already Installed (from Phase 1)

All libraries above are already in the pnpm catalog and available. No new `pnpm add` commands needed for Phase 2.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `node:readline` | `stream-json`, `jsonl-parse` | External dep -- violates zero-dep constraint |
| `valibot safeParse` | Manual JSON.parse + type checks | No schema validation, more error-prone, less maintainable |
| `tinyglobby` | `node:fs.readdir` + recursion | More code, no glob pattern support, reinventing the wheel |
| Duration parser (custom) | `ms` library, `dayjs` | External deps. Duration parsing is trivial (~20 lines). |

## Architecture Patterns

### Recommended Project Structure

```
packages/internal/src/
  types.ts                    # Existing: GhostItem, ClaudePaths, etc.
  schemas/
    session-line.ts           # Valibot schemas for JSONL line types
    tool-use.ts               # Valibot schemas for tool_use content blocks
  parser/
    discover.ts               # Session file discovery (tinyglobby)
    parse-session.ts          # Streaming JSONL parser (readline + valibot)
    extract-invocations.ts    # Tool_use block -> invocation record extraction
    duration.ts               # --since duration string parser
    types.ts                  # Parser-specific types (InvocationRecord, SessionMeta, etc.)
    index.ts                  # Barrel re-export
apps/ccaudit/src/
  cli/commands/ghost.ts       # Updated: wires --since flag, calls parser pipeline
```

**Rationale for `packages/internal/`:** The parser is shared infrastructure. Phase 3 (Inventory Scanner) will import from `@ccaudit/internal` to cross-reference invocations against installed inventory. Placing parser code in `packages/internal/` follows ccusage's pattern.

### Pattern 1: Session Discovery

**What:** Use tinyglobby to find all `.jsonl` files in Claude's dual-path structure.
**When to use:** At the start of every audit operation.

```typescript
// Source: Verified from real filesystem inspection (this machine)
import { glob } from 'tinyglobby';
import { homedir } from 'node:os';
import path from 'node:path';

export async function discoverSessionFiles(options?: {
  claudePaths?: { xdg: string; legacy: string };
}): Promise<string[]> {
  const home = homedir();
  const paths = options?.claudePaths ?? {
    xdg: path.join(home, '.config', 'claude'),
    legacy: path.join(home, '.claude'),
  };

  // CRITICAL: Use path.posix for glob patterns (tinyglobby expects forward slashes)
  const patterns = [paths.xdg, paths.legacy].flatMap(base => {
    const posixBase = base.replace(/\\/g, '/');
    return [
      `${posixBase}/projects/*/*.jsonl`,                      // Main sessions
      `${posixBase}/projects/*/*/subagents/agent-*.jsonl`,    // Subagent sessions
    ];
  });

  return glob(patterns, { absolute: true, dot: false });
}
```

### Pattern 2: Streaming JSONL Parser

**What:** Line-by-line streaming with double validation (JSON.parse + valibot safeParse).
**When to use:** For every session file.

```typescript
// Source: ccusage data-loader.ts pattern, adapted for ccaudit schema
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import * as v from 'valibot';

const MAX_LINE_SIZE = 10 * 1024 * 1024; // 10MB safety limit

async function* parseSessionFile(filePath: string): AsyncGenerator<ParsedLine> {
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    if (line.length === 0) continue;
    if (line.length > MAX_LINE_SIZE) continue; // OOM protection
    try {
      const json = JSON.parse(line) as unknown;
      const result = v.safeParse(sessionLineSchema, json);
      if (!result.success) continue; // Silent skip
      yield result.output;
    } catch {
      continue; // Malformed JSON -- silent skip
    }
  }
}
```

### Pattern 3: Tool Invocation Extraction

**What:** Classify tool_use blocks into Agent, Skill, or MCP invocations.
**When to use:** For each `type=assistant` message line.

```typescript
// Source: Verified from real JSONL inspection + ccboard classification logic
type InvocationKind = 'agent' | 'skill' | 'mcp';

interface InvocationRecord {
  kind: InvocationKind;
  name: string;          // Agent type, skill name, or MCP server
  tool?: string;         // MCP tool name (only for MCP)
  sessionId: string;
  timestamp: string;     // ISO 8601
  projectPath: string;   // From cwd field
  isSidechain: boolean;
}

function extractInvocations(line: AssistantLine): InvocationRecord[] {
  const records: InvocationRecord[] = [];
  for (const block of line.message.content) {
    if (block.type !== 'tool_use') continue;

    // Agent: name === 'Agent' OR name === 'Task' (older versions)
    if (block.name === 'Agent' || block.name === 'Task') {
      const agentType = block.input?.subagent_type;
      if (agentType) {
        records.push({
          kind: 'agent',
          name: agentType,
          sessionId: line.sessionId,
          timestamp: line.timestamp,
          projectPath: line.cwd,
          isSidechain: line.isSidechain ?? false,
        });
      }
      continue;
    }

    // Skill: name === 'Skill'
    if (block.name === 'Skill') {
      const skillName = block.input?.skill;
      if (skillName) {
        records.push({
          kind: 'skill',
          name: skillName,
          sessionId: line.sessionId,
          timestamp: line.timestamp,
          projectPath: line.cwd,
          isSidechain: line.isSidechain ?? false,
        });
      }
      continue;
    }

    // MCP: name starts with 'mcp__'
    if (block.name.startsWith('mcp__')) {
      const parsed = parseMcpName(block.name);
      if (parsed) {
        records.push({
          kind: 'mcp',
          name: parsed.server,
          tool: parsed.tool,
          sessionId: line.sessionId,
          timestamp: line.timestamp,
          projectPath: line.cwd,
          isSidechain: line.isSidechain ?? false,
        });
      }
      continue;
    }
  }
  return records;
}
```

### Pattern 4: Duration String Parser

**What:** Parse `--since` human-readable duration into milliseconds offset.
**When to use:** CLI argument processing.

```typescript
// No external dep needed -- duration parsing is trivial
const DURATION_UNITS: Record<string, number> = {
  d: 86_400_000,    // days
  w: 604_800_000,   // weeks
  m: 2_592_000_000, // months (30 days)
  h: 3_600_000,     // hours
};

function parseDuration(input: string): number {
  const match = input.match(/^(\d+)\s*(d|w|m|h)$/i);
  if (!match) throw new Error(`Invalid duration: "${input}". Use e.g. 7d, 2w, 1m`);
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  return value * DURATION_UNITS[unit];
}
```

### Anti-Patterns to Avoid

- **Loading entire file into memory**: Session files can be 60MB+. Always stream with readline.
- **Strict schema validation**: Do NOT use `v.parse()` (throws). Always use `v.safeParse()` (returns result).
- **Decoding project path from folder name**: The folder name encoding (e.g., `-Users-helldrik-gitRepos`) is an implementation detail. Use the `cwd` field from JSONL lines instead.
- **Assuming `sessions/` subdirectory exists**: Real Claude Code does NOT use a `sessions/` subdirectory. Sessions are directly under the project folder.
- **Only checking `name === 'Agent'`**: Must also check `name === 'Task'` for backward compatibility.
- **Using `v.object()` strict mode for top-level lines**: JSONL lines have many optional fields that vary by type. Use `v.object()` with `v.optional()` liberally, or use `v.looseObject()`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Schema validation | Manual type guards with `if` chains | `valibot safeParse` | Type-safe, self-documenting schemas, handles edge cases (null, undefined, wrong types) |
| File globbing | `fs.readdir` + path matching | `tinyglobby glob()` | Cross-platform glob patterns, ignore support, async, 2 subdeps |
| Line-by-line streaming | `fs.readFile` + `split('\n')` | `node:readline createInterface` | Constant memory, handles CRLF, backpressure, async iteration |
| Result error handling | try/catch everywhere | `@praha/byethrow` at I/O boundaries | Composable error chains, type-safe errors, ccusage pattern |
| Path joining for globs | String concatenation | `path.posix.join` for patterns | Forward slashes on all platforms for tinyglobby |

## JSONL Schema Findings (from Real Data Inspection)

### Session File Location (CRITICAL CORRECTION)

**Requirements say:** `~/.claude/projects/*/sessions/*.jsonl`
**Reality (verified on this machine):** `~/.claude/projects/<encoded-path>/<session-uuid>.jsonl`

There is **NO `sessions/` subdirectory**. The structure is:

```
~/.claude/projects/
  -Users-helldrik-gitRepos--obsidian-mentor-knowledge-pipeline/    # Encoded project path
    e478962a-d5db-4ce6-bff0-b21a13e88787.jsonl                    # Main session
    e478962a-d5db-4ce6-bff0-b21a13e88787/                         # Session data dir
      subagents/                                                    # Subagent sessions
        agent-ab4068950c018ac0f.jsonl
        agent-a3c8272f3b4ec8586.jsonl
      tool-results/                                                 # Tool result data
    5f39cd97-6753-4d25-af94-725d90dbfa3c.jsonl                    # Another session
    memory/                                                         # Project memory
```

**Correct glob patterns:**
- Main sessions: `<base>/projects/*/*.jsonl`
- Subagent sessions: `<base>/projects/*/*/subagents/agent-*.jsonl`

### Message Types

All unique `type` values found across multiple session files:

| Type | Purpose | Has `cwd`? | Has `message.content`? |
|------|---------|------------|------------------------|
| `assistant` | LLM responses (contains tool_use blocks) | Yes | Yes (array of content blocks) |
| `user` | User messages and tool_results | Yes | Yes |
| `system` | System prompts | Yes | Yes |
| `progress` | Hook events, tool progress | Yes | No (has `data` instead) |
| `queue-operation` | Enqueue/dequeue operations | No (has `sessionId`) | Has `content` (string) |
| `agent-name` | Agent name assignment | Varies | No |
| `custom-title` | Session title | Varies | No |
| `file-history-snapshot` | File state tracking | Varies | No |
| `last-prompt` | Last user prompt | Varies | No |

**Key observation:** `cwd` is present on `user`, `assistant`, and `system` messages -- not just `system`. The first message with `cwd` in a file is authoritative for project path resolution.

### Tool Invocation Detection (Confirmed from Real Data)

**Agent invocation** (verified):
```json
{
  "type": "tool_use",
  "id": "toolu_01EQvCMEGdRAapGx5nTXkNHc",
  "name": "Agent",
  "input": {
    "subagent_type": "Explore",
    "prompt": "Do a very thorough exploration..."
  },
  "caller": { "type": "direct" }
}
```

**Skill invocation** (verified):
```json
{
  "type": "tool_use",
  "id": "toolu_016isWcFXG6PA6A6M9gnxvGX",
  "name": "Skill",
  "input": {
    "skill": "gsd:plan-phase",
    "args": "1"
  },
  "caller": { "type": "direct" }
}
```

**MCP invocation** (verified):
```json
{
  "type": "tool_use",
  "id": "toolu_01MoRNiHn9sPUjwJKbvD8Jas",
  "name": "mcp__Claude_in_Chrome__tabs_context_mcp",
  "input": { "createIfEmpty": "True" },
  "caller": { "type": "direct" }
}
```

**Backward compatibility:** ccboard and who-ran-what both use `name === 'Task'` for agent detection. Our data shows `name === 'Agent'`. Claude Code likely renamed from `Task` to `Agent` at some point. **Must support both.**

### Subagent Structure (Confirmed)

- Subagent files stored in `<session-uuid>/subagents/agent-<hash>.jsonl`
- All lines have `isSidechain: true`
- `sessionId` matches the parent session's UUID
- `cwd` is the same as the parent session
- `parentUuid` links individual messages to parent message chain

### CWD Resolution

- `cwd` field is present on `user`, `assistant`, and `system` type messages
- Value is an absolute filesystem path: `/Users/helldrik/gitRepos/_obsidian/mentor-knowledge-pipeline`
- On Windows, may contain backslashes -- normalize with `path.normalize()`
- Strategy: Read first message with `cwd` field; that is the authoritative project path

### Timestamp Format

- ISO 8601 with milliseconds: `"2026-03-27T21:26:27.174Z"`
- Always UTC (Z suffix)
- Present on all message types
- Used for `--since` time window filtering

### Scale Metrics (from This Machine)

| Metric | Value | Implication |
|--------|-------|-------------|
| Total JSONL files | 4,567 | Must be async/parallel |
| Total projects | 88 | Moderate cardinality |
| Largest file | 60 MB | Streaming mandatory, line-size protection needed |
| Subagent files | Thousands | Must include in discovery |

## Common Pitfalls

### Pitfall 1: Incorrect Session File Path

**What goes wrong:** Parser finds zero session files because it looks for `projects/*/sessions/*.jsonl`.
**Why it happens:** The requirements doc (PARS-01) specifies a `sessions/` subdirectory that does not exist in real Claude Code data.
**How to avoid:** Use verified glob patterns: `projects/*/*.jsonl` for main sessions, `projects/*/*/subagents/agent-*.jsonl` for subagents.
**Warning signs:** Empty file discovery result, zero invocations found.

### Pitfall 2: Only Detecting `Agent` Tool Name

**What goes wrong:** Misses agent invocations from older Claude Code sessions.
**Why it happens:** Claude Code renamed the tool from `Task` to `Agent` at some point. Older sessions use `Task`.
**How to avoid:** Check for both `name === 'Agent'` and `name === 'Task'` in tool_use blocks.
**Warning signs:** Agent counts significantly lower than expected.

### Pitfall 3: Strict Schema Validation Rejecting Valid Lines

**What goes wrong:** Parser skips valid lines because the valibot schema is too strict.
**Why it happens:** JSONL lines have variable shapes depending on type. An `assistant` message has different fields than a `progress` event.
**How to avoid:** Use `v.optional()` for fields that may not be present. Only validate the fields you need. Use a discriminated union on the `type` field.
**Warning signs:** High skip rate in verbose mode.

### Pitfall 4: OOM on Large Session Files

**What goes wrong:** Process crashes when parsing a 60MB session file.
**Why it happens:** Either loading the entire file into memory or accumulating too many parsed records.
**How to avoid:** (1) Use `createReadStream` + `readline` for constant-memory streaming. (2) Add `MAX_LINE_SIZE` (10MB) protection. (3) Yield records via `AsyncGenerator` instead of collecting into an array.
**Warning signs:** Memory usage spikes, Node.js heap OOM error.

### Pitfall 5: Windows Path Separator in Glob Patterns

**What goes wrong:** tinyglobby finds zero files on Windows.
**Why it happens:** `path.join` on Windows produces backslashes, but tinyglobby requires forward slashes in glob patterns.
**How to avoid:** Use `path.posix.join` for constructing glob patterns, or `.replace(/\\/g, '/')` on joined paths.
**Warning signs:** Works on macOS/Linux, fails on Windows.

### Pitfall 6: MCP Server Names with Embedded Underscores

**What goes wrong:** MCP server name incorrectly split when the server name itself contains underscores.
**Why it happens:** Naive split on `__` may not handle `mcp__Claude_in_Chrome__tabs_context_mcp` correctly.
**How to avoid:** Strip `mcp__` prefix, then find the FIRST occurrence of `__` in the remainder. Everything before is server, everything after is tool.
**Warning signs:** MCP server name truncated or tool name includes part of server name.

### Pitfall 7: Time Window Filtering on File mtime vs Content Timestamps

**What goes wrong:** Sessions within the time window are excluded because the file's modification time is outside the window, or vice versa.
**Why it happens:** Using `fs.stat().mtime` to pre-filter files instead of reading timestamps from JSONL content.
**How to avoid:** Use file mtime as a fast pre-filter (skip files older than `--since` window), but always verify with content timestamps. A file modified 30 days ago may still contain messages from 7 days ago if it was a long-running session.
**Warning signs:** Missing invocations that should appear in the time window.

## Code Examples

### Example 1: Valibot Schema for Session Line (Tool Use Extraction)

```typescript
// Source: Verified from real JSONL inspection on this machine
import * as v from 'valibot';

// Content block in assistant messages
const toolUseBlockSchema = v.object({
  type: v.literal('tool_use'),
  id: v.string(),
  name: v.string(),
  input: v.optional(v.record(v.string(), v.unknown())),
  caller: v.optional(v.object({
    type: v.string(),
  })),
});

const contentBlockSchema = v.union([
  toolUseBlockSchema,
  v.object({ type: v.literal('text'), text: v.string() }),
  v.object({ type: v.string() }), // Catch-all for other block types
]);

// Assistant message line (the one we extract invocations from)
const assistantLineSchema = v.object({
  type: v.literal('assistant'),
  sessionId: v.string(),
  timestamp: v.string(),
  cwd: v.optional(v.string()),
  isSidechain: v.optional(v.boolean()),
  parentUuid: v.optional(v.nullable(v.string())),
  message: v.object({
    role: v.literal('assistant'),
    content: v.union([
      v.array(contentBlockSchema),
      v.string(),
    ]),
  }),
});

// Lightweight schema for any line (just to get type + cwd + timestamp)
const anyLineSchema = v.object({
  type: v.string(),
  sessionId: v.optional(v.string()),
  timestamp: v.optional(v.string()),
  cwd: v.optional(v.string()),
  isSidechain: v.optional(v.boolean()),
});
```

### Example 2: MCP Name Parser

```typescript
// Source: claude-code-trace Rust parser, adapted to TypeScript
// Verified against real data: "mcp__Claude_in_Chrome__tabs_context_mcp"

export function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5); // Strip 'mcp__' prefix
  const separatorIndex = rest.indexOf('__');
  if (separatorIndex === -1) return null;
  return {
    server: rest.slice(0, separatorIndex),
    tool: rest.slice(separatorIndex + 2),
  };
}

// parseMcpName('mcp__Claude_in_Chrome__tabs_context_mcp')
// => { server: 'Claude_in_Chrome', tool: 'tabs_context_mcp' }
```

### Example 3: Duration Parser for `--since` Flag

```typescript
// Source: Custom (trivial utility, no external dep needed)
const UNITS: Record<string, number> = {
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  m: 2_592_000_000, // 30 days
};

export function parseDuration(input: string): number {
  const match = input.trim().match(/^(\d+)\s*([hdwm])$/i);
  if (!match) {
    throw new Error(
      `Invalid duration "${input}". Expected format: <number><unit> where unit is h (hours), d (days), w (weeks), or m (months). Examples: 7d, 2w, 1m`
    );
  }
  return parseInt(match[1], 10) * UNITS[match[2].toLowerCase()];
}

// For gunshi custom arg:
// { type: 'custom', short: 's', default: '7d', parse: parseDuration, description: '...' }
```

### Example 4: Complete Session Processing Pipeline

```typescript
// Source: Architecture synthesis from ccusage + ccboard patterns
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import * as v from 'valibot';

const MAX_LINE_SIZE = 10 * 1024 * 1024;

export async function processSession(
  filePath: string,
  sinceMs: number,
): Promise<{ projectPath: string | null; invocations: InvocationRecord[] }> {
  const invocations: InvocationRecord[] = [];
  let projectPath: string | null = null;
  const now = Date.now();
  const cutoff = now - sinceMs;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    if (line.length === 0 || line.length > MAX_LINE_SIZE) continue;

    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue; // Silent skip: malformed JSON
    }

    // Fast path: extract cwd from first line that has it
    if (projectPath === null) {
      const meta = v.safeParse(anyLineSchema, json);
      if (meta.success && meta.output.cwd) {
        projectPath = meta.output.cwd;
      }
    }

    // Only process assistant messages for tool_use extraction
    const result = v.safeParse(assistantLineSchema, json);
    if (!result.success) continue;

    const assistantLine = result.output;

    // Time window filter
    if (assistantLine.timestamp) {
      const ts = new Date(assistantLine.timestamp).getTime();
      if (ts < cutoff) continue; // Outside --since window
    }

    // Extract invocations from content blocks
    if (Array.isArray(assistantLine.message.content)) {
      for (const block of assistantLine.message.content) {
        // ... classification logic (Agent/Task, Skill, MCP)
      }
    }
  }

  return { projectPath, invocations };
}
```

### Example 5: Session File Discovery with Pre-filtering

```typescript
// Source: tinyglobby API (verified from installed types) + ccusage path resolution
import { glob } from 'tinyglobby';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export async function discoverSessionFiles(sinceMs: number): Promise<string[]> {
  const home = homedir();
  const bases = [
    path.join(home, '.config', 'claude'),  // XDG
    path.join(home, '.claude'),             // Legacy
  ];

  const patterns = bases.flatMap(base => {
    const b = base.replace(/\\/g, '/'); // Forward slashes for tinyglobby
    return [
      `${b}/projects/*/*.jsonl`,
      `${b}/projects/*/*/subagents/agent-*.jsonl`,
    ];
  });

  const allFiles = await glob(patterns, { absolute: true, dot: false });

  // Fast pre-filter: skip files whose mtime is older than the window
  // (they can't contain recent invocations)
  const cutoff = Date.now() - sinceMs;
  const filtered: string[] = [];
  for (const file of allFiles) {
    try {
      const stats = await stat(file);
      if (stats.mtimeMs >= cutoff) {
        filtered.push(file);
      }
    } catch {
      continue; // File disappeared between glob and stat
    }
  }

  return filtered;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `name === 'Task'` for agents | `name === 'Agent'` for agents | Claude Code ~2025-2026 | Must support both for backward compat |
| `~/.claude/` only | `~/.config/claude/` (XDG) + `~/.claude/` (legacy) | Claude Code ~2025 | Dual-path discovery required |
| `settings.json` for MCP | `~/.claude.json` + `.mcp.json` | Claude Code ~2025 | Affects Phase 3 (MCP scanner), not Phase 2 |

**Deprecated/outdated:**
- `sessions/` subdirectory: Does not exist in current Claude Code. Sessions are directly under project dir.
- `name === 'Task'` only: Still works for old sessions but `Agent` is the current tool name.

## Open Questions

1. **`CLAUDE_CONFIG_DIR` environment variable**
   - What we know: ccusage supports `CLAUDE_CONFIG_DIR` env var to override default paths (comma-separated)
   - What's unclear: Is this an official Claude Code feature or ccusage-specific?
   - Recommendation: Support it for parity with ccusage. Low cost, high compatibility.

2. **MCP server names with double underscores**
   - What we know: MCP tool name format is `mcp__<server>__<tool>`. The server and tool names can contain single underscores.
   - What's unclear: Can a server name contain `__` (double underscore)? This would break the split logic.
   - Recommendation: Split on first `__` after stripping `mcp__` prefix. This is what claude-code-trace does. If a server name has `__`, it would already be ambiguous in Claude Code itself, so unlikely.

3. **File mtime pre-filtering accuracy**
   - What we know: Using file mtime to skip old files is a fast optimization. But a file could have been written over days.
   - What's unclear: Does Claude Code append to JSONL files across multiple days for the same session?
   - Recommendation: Use mtime as pre-filter but add a generous buffer (e.g., `sinceMs * 2`). Or skip pre-filtering in v1 if performance is acceptable -- 4,567 files is manageable.

4. **Progress and queue-operation events**
   - What we know: These event types exist in JSONL but don't contain tool_use blocks.
   - What's unclear: Are there other event types in newer Claude Code versions?
   - Recommendation: Use a permissive top-level schema. Only parse `type === 'assistant'` deeply for tool_use extraction. Skip everything else silently.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.2 |
| Config file | `apps/ccaudit/vitest.config.ts` (exists, has `includeSource`) |
| Quick run command | `pnpm --filter ccaudit test` |
| Full suite command | `pnpm test` (runs all workspace projects) |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PARS-01 | Session files discovered from dual paths | unit (mock fs) | `pnpm --filter @ccaudit/internal test` | Wave 0 |
| PARS-02 | Subagent sessions included | unit (mock fs) | `pnpm --filter @ccaudit/internal test` | Wave 0 |
| PARS-03 | Agent invocations extracted (both `Agent` and `Task`) | unit (in-source) | `pnpm --filter @ccaudit/internal test` | Wave 0 |
| PARS-04 | Skill invocations extracted | unit (in-source) | `pnpm --filter @ccaudit/internal test` | Wave 0 |
| PARS-05 | MCP invocations extracted and split | unit (in-source) | `pnpm --filter @ccaudit/internal test` | Wave 0 |
| PARS-06 | Project path from cwd field | unit (in-source) | `pnpm --filter @ccaudit/internal test` | Wave 0 |
| PARS-07 | Duration parser handles 7d, 30d, 1w, etc. | unit (in-source) | `pnpm --filter @ccaudit/internal test` | Wave 0 |

### Testing Strategy

**In-source tests** (preferred for utility functions):
- `parseMcpName()` -- unit tests with real MCP names
- `parseDuration()` -- unit tests with valid and invalid inputs
- `extractInvocations()` -- unit tests with fixture JSONL lines
- Schema validation -- test with known-good and known-bad JSON structures

**Fixture-based tests** (for integration):
- Create `packages/internal/src/parser/__fixtures__/` directory with sample `.jsonl` files
- Include: valid session, malformed JSON, empty lines, oversized lines, mixed types
- Test full pipeline: discover -> parse -> extract

### Sampling Rate
- **Per task commit:** `pnpm --filter @ccaudit/internal test`
- **Per wave merge:** `pnpm test` (full suite)
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `packages/internal/src/parser/__fixtures__/` -- sample JSONL test data
- [ ] `packages/internal/vitest.config.ts` -- needs `includeSource` for in-source tests
- [ ] In-source test blocks in each new parser module

## Sources

### Primary (HIGH confidence)
- **Local filesystem inspection** -- Real Claude Code JSONL files on this machine (4,567 files, 88 projects)
- **ccusage source code** -- JSONL parsing patterns, dual-path resolution, streaming architecture
- **ccboard source code** -- 5-type tool classification, MCP parsing, file size protection
- **valibot 1.3.1 API** -- `safeParse()` behavior verified from installed types
- **tinyglobby 0.2.15 API** -- `glob()` signature verified from installed types
- **gunshi 0.29.3 API** -- `type: 'custom'` with `parse` function verified from installed types

### Secondary (MEDIUM confidence)
- **who-ran-what source code** -- Set-difference ghost detection, confirms `Task` tool name usage
- **claude-code-trace source code** -- MCP `mcp__<server>__<tool>` split logic (Rust)
- **claude-code-transcripts source code** -- Subagent directory filtering

### Tertiary (LOW confidence)
- **Agent/Task tool name transition timing** -- No official changelog found. Based on comparing repo ages and local data.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- All libraries installed and verified, APIs confirmed from type definitions
- Architecture: HIGH -- Patterns verified from 8 reference implementations + real data inspection
- JSONL schema: HIGH -- Verified from actual session files on this machine
- Path structure: HIGH -- Verified from actual filesystem (contradicts requirements doc)
- Pitfalls: HIGH -- Each pitfall sourced from either real data or confirmed reference implementations

**Research date:** 2026-04-03
**Valid until:** 2026-05-03 (stable domain -- Claude Code JSONL schema changes slowly)

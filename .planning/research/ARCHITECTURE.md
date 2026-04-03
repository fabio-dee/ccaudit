# Architecture Research -- ccaudit

**Domain:** TypeScript CLI tool for JSONL session audit + optional filesystem remediation
**Researched:** 2026-04-03
**Overall confidence:** HIGH

---

## Component Map

ccaudit decomposes into **9 major components** organized across the monorepo. Each has a single responsibility and communicates through typed interfaces, never by reaching into another component's internals.

### 1. CLI Router (`apps/ccaudit/src/cli/`)

**Responsibility:** Parse arguments, route to command handlers, manage global flags.
**Framework:** `gunshi` -- declarative command definitions with lazy-loaded subcommands and type-safe argument parsing. This is the same framework ccusage uses, ensuring ecosystem consistency.

**Subcommands:**
- `ghost` (default) -- full ghost inventory report
- `inventory` -- all defined items regardless of usage
- `mcp` -- MCP-focused view with optional `--live`
- `trend` -- usage over time
- `restore` -- rollback operations (v1.2)
- `contribute` -- generate PR payload for `mcp-token-estimates.json` (v1.2+)

**Key design:** Each command is a separate file exporting a gunshi command definition. The router never contains business logic -- it calls into the Pipeline Orchestrator. Command handlers are thin wrappers: discover -> parse -> detect -> render.

### 2. Session Discovery (`packages/internal/src/discovery/`)

**Responsibility:** Find all JSONL session files, resolve project paths, handle dual-path support.
**Inputs:** Environment variables (`CLAUDE_CONFIG_DIR`), default paths (`~/.claude/projects/`, `~/.config/claude/projects/`)
**Outputs:** `SessionFile[]` -- array of `{ path, projectPath, sessionId }`

Discovers files using `tinyglobby` with pattern `projects/*/sessions/**/*.jsonl`. Checks `CLAUDE_CONFIG_DIR` env var first, then scans both XDG path and legacy path (not either/or -- users may have sessions in both). Also discovers subagent sessions in `subagents/` subdirectories, tagged with `isSidechain: true`.

### 3. JSONL Parser (`packages/internal/src/parser/`)

**Responsibility:** Read JSONL files line-by-line, extract structured invocation events, silently skip malformed lines. Never throw on bad data.

**Inputs:** `SessionFile`
**Outputs:** `ParsedSession` containing `InvocationEvent[]`

**Line processing pipeline:**
1. Read file using `node:readline` async iterator over `createReadStream()` -- constant memory, handles 100MB+ files
2. For each line: `JSON.parse()` wrapped in try/catch -- malformed lines yield `null`, silently skipped
3. For valid JSON: `valibot.safeParse()` against message schema -- schema failures yield `null`, silently skipped
4. For valid messages: delegate to Invocation Extractor

**Memory strategy:** Use async generators to stream JSONL lines without loading entire files into memory. Session files can be large for power users with months of history.

```typescript
async function* parseSessionFile(
  filePath: string,
  schema: v.BaseSchema,
): AsyncGenerator<SessionLine> {
  const rl = createInterface({ input: createReadStream(filePath) });
  for await (const line of rl) {
    try {
      const json = JSON.parse(line);
      const result = v.safeParse(schema, json);
      if (!result.success) continue;
      yield result.output;
    } catch {
      continue; // malformed JSON -- silent skip
    }
  }
}
```

### 4. Invocation Extractor (`packages/internal/src/parser/extractors/`)

**Responsibility:** From a parsed message, extract typed invocation events for agents, skills, and MCP tools.
**Inputs:** Parsed JSON message object (type === 'assistant')
**Outputs:** `InvocationEvent` discriminated union

Three extraction functions, each handling one invocation type:

```typescript
// Agents: tool_use where name === 'Agent'
interface AgentInvocation {
  type: 'agent';
  name: string;          // from input.subagent_type
  sessionId: string;
  timestamp: string;
  isSidechain: boolean;
}

// Skills: tool_use where name === 'Skill'
interface SkillInvocation {
  type: 'skill';
  name: string;          // from input.skill (e.g., 'gsd:new-project')
  sessionId: string;
  timestamp: string;
}

// MCP: tool_use where name matches mcp__*__*
interface McpInvocation {
  type: 'mcp';
  server: string;        // split on '__', index [1]
  tool: string;          // split on '__', index [2]
  sessionId: string;
  timestamp: string;
}

type InvocationEvent = AgentInvocation | SkillInvocation | McpInvocation;
```

**Extraction rules (confirmed from JSONL inspection):**
- Filter to `type === 'assistant'` messages only
- Scan `content` array for blocks with `type === 'tool_use'`
- Agent: `block.name === 'Agent'` --> `block.input.subagent_type` is the agent name
- Skill: `block.name === 'Skill'` --> `block.input.skill` is the skill name
- MCP: `block.name` matches `/^mcp__[^_]+__[^_]+$/` --> split on `__`, parts[1] = server, parts[2] = tool

### 5. Invocation Ledger (`packages/internal/src/ledger/`)

**Responsibility:** Aggregate invocation events into a queryable ledger. The central data structure that all downstream components consume.
**Inputs:** `InvocationEvent[]` from all parsed sessions
**Outputs:** `InvocationLedger`

```typescript
interface InvocationLedger {
  agents: Map<string, LedgerEntry>;
  skills: Map<string, LedgerEntry>;
  mcpServers: Map<string, McpServerEntry>;
  timeRange: { earliest: Date; latest: Date };
  sessionCount: number;
}

interface LedgerEntry {
  name: string;
  invocationCount: number;
  lastUsed: Date;
  sessionIds: Set<string>;
}

interface McpServerEntry extends LedgerEntry {
  tools: Map<string, LedgerEntry>;  // tool-level breakdown within server
}
```

Supports `--since` filtering: events outside the time window are excluded during construction. Default window: 7 days. Deduplication: by composite key `(sessionId, timestamp, type, name)`.

### 6. Config Scanner (`packages/internal/src/scanner/`)

**Responsibility:** Discover what is *defined* (installed/configured) regardless of usage. This produces the "Defined" column in the ghost report.
**Inputs:** Filesystem paths for agents, skills, MCP config, memory files
**Outputs:** `InstalledInventory`

**Scans these locations:**
- **Agents:** `~/.claude/agents/*.md`, `.claude/agents/*.md` (project-local)
- **Skills:** `~/.claude/skills/*.md`, `.claude/skills/*.md` (project-local)
- **MCP servers:** `~/.claude.json` (global `mcpServers` key), `.mcp.json` (project-level `mcpServers` key)
- **Memory files:** `~/.claude/CLAUDE.md`, `~/.claude/rules/**`, `.claude/CLAUDE.md`, `.claude/rules/**`

```typescript
interface InstalledInventory {
  agents: InstalledItem[];
  skills: InstalledItem[];
  mcpServers: InstalledMcpServer[];
  memoryFiles: InstalledMemoryFile[];
}

interface InstalledItem {
  name: string;
  path: string;
  scope: 'global' | 'project';
}

interface InstalledMcpServer {
  name: string;
  configPath: string;         // which file defines it (~/.claude.json or .mcp.json)
  scope: 'global' | 'project';
  config: Record<string, unknown>;  // raw server config preserved for restore
}

interface InstalledMemoryFile {
  name: string;
  path: string;
  lastModified: Date;
  scope: 'global' | 'project';
}
```

**Critical nuance on MCP config files:** Claude Code uses `~/.claude.json` for user-scope MCP servers and `.mcp.json` for project-scope MCP servers. These are plain JSON (not JSONC). The `settings.json` files (`~/.claude/settings.json`, `.claude/settings.json`) hold permissions and other settings but NOT MCP server definitions. The remediation component must understand this distinction.

### 7. Ghost Detector (`packages/internal/src/detector/`)

**Responsibility:** Compare the Invocation Ledger against the Installed Inventory to produce the ghost report.
**Inputs:** `InvocationLedger`, `InstalledInventory`
**Outputs:** `GhostReport`

```typescript
interface GhostReport {
  agents: GhostItem[];
  skills: GhostItem[];
  mcpServers: GhostMcpItem[];
  memoryFiles: GhostMemoryItem[];
  summary: {
    totalDefined: number;
    totalUsed: number;
    totalGhost: number;
    estimatedTokenWaste: number;
  };
}

interface GhostItem {
  name: string;
  path: string;
  scope: 'global' | 'project';
  status: 'used' | 'ghost';
  invocationCount: number;
  lastUsed: Date | null;
  estimatedTokenCost: number;
}
```

**Ghost classification:**
- Ghost: present in `InstalledInventory`, zero invocations in `InvocationLedger` within time window
- Used: >= 1 invocation within time window
- Memory files: "stale" if `lastModified` older than `--since` window and no references in sessions

**Token cost estimation:** Uses embedded `mcp-token-estimates.json` containing per-item context-loading cost estimates (tokens added to context window at session start, not per-invocation). Community-maintained via `ccaudit contribute`.

### 8. Report Renderer (`packages/terminal/src/`)

**Responsibility:** Format ghost reports for terminal, JSON, or CSV output.
**Inputs:** `GhostReport` (or `InstalledInventory` for `inventory` command)
**Outputs:** Formatted string to stdout

Uses `cli-table3` for terminal tables. Follows ccusage's `ResponsiveTable` pattern: detect terminal width via `process.stdout.columns`, switch to compact mode for narrow terminals (< 100 chars).

**Table columns for ghost report:**

| Category | Defined | Used | Ghost | Est. Token Waste |
|----------|---------|------|-------|------------------|

Each category (Agents, Skills, MCP Servers, Memory Files) gets its own section with per-item detail and a category subtotal. Summary row shows total estimated waste.

**Output modes:**
- Terminal table (default) -- colored, responsive, unicode borders
- `--json` -- structured JSON to stdout (machine-consumable)
- `--csv` -- CSV with headers to stdout (spreadsheet-friendly)

### 9. Remediation Engine (`apps/ccaudit/src/remediation/`)

**Responsibility:** Execute ghost removal and rollback. Lives in `apps/ccaudit/` (not `packages/internal/`) because it performs filesystem mutation -- shared packages must remain read-only and side-effect-free.

**Sub-components:**
- **Checkpoint Manager** (`checkpoint.ts`) -- create, validate, and compare checkpoints
- **Archive Manager** (`archive.ts`) -- move agents/skills to `_archived/`
- **MCP Disabler** (`mcp-disabler.ts`) -- disable servers in config files
- **Memory Flagger** (`memory-flagger.ts`) -- add frontmatter flags to stale files
- **Restore Manager** (`restore.ts`) -- reverse all remediation operations
- **Manifest Manager** (`manifest.ts`) -- read/write restore manifests

Detailed in the Rollback Architecture section below.

---

## Data Flow

The complete data flow from raw JSONL to final output:

```
Phase 1: Discovery (read-only, parallelizable)
================================================

  Filesystem                    Config Files
  (~/.claude/projects/          (~/.claude.json, .mcp.json,
   ~/.config/claude/projects/)   agents/, skills/, rules/)
      |                              |
      v                              v
  Session Discovery            Config Scanner
  (tinyglobby glob)            (fs.readFile + JSON.parse)
      |                              |
      v                              v
  SessionFile[]                InstalledInventory


Phase 2: Parsing (read-only, parallelizable per file)
======================================================

  SessionFile[]
      |
      v (for each file, via async generator)
  JSONL Parser
  (readline stream -> JSON.parse -> valibot.safeParse)
      |
      v (per valid message)
  Invocation Extractor
  (agent/skill/mcp pattern matching)
      |
      v
  InvocationEvent[] (per session)
      |
      v (aggregated across all sessions)
  Invocation Ledger
  (Map-based, filtered by --since)


Phase 3: Analysis (pure computation, no I/O)
=============================================

  InvocationLedger + InstalledInventory
           |
           v
     Ghost Detector
     (set difference + token estimates)
           |
           v
     GhostReport


Phase 4: Output (stdout only)
==============================

  GhostReport
      |
      v
  Report Renderer
      |
      +---> Terminal table (default, cli-table3)
      +---> JSON (--json)
      +---> CSV (--csv)
      +---> Exit code: 0 = no ghosts, 1 = ghosts found


Phase 5: Dry-Run (v1.1, single file write)
============================================

  GhostReport + InstalledInventory
      |
      v
  Checkpoint Manager
  (SHA-256 hash of inventory state)
      |
      v
  Write ~/.claude/ccaudit/.last-dry-run
  Display remediation plan, exit


Phase 6: Remediation (v1.2, gated filesystem mutation)
=======================================================

  --dangerously-bust-ghosts
      |
      v
  Validate checkpoint
  (hash must match current inventory state)
      |
      v
  Triple confirmation prompt
  ("I accept full responsibility")
      |
      v
  Execute remediation plan (incremental manifest writes):
      |
      +---> Archive Manager: agents/skills -> _archived/
      +---> MCP Disabler: rename server keys in config
      +---> Memory Flagger: add ccaudit-stale frontmatter
      |
      v
  Write ~/.claude/ccaudit/.last-bust (restore manifest)


Phase 7: Restore (v1.2, reverse mutation)
==========================================

  ccaudit restore [--list | <name>]
      |
      v
  Read restore manifest
      |
      v
  Reverse each operation:
      +---> Move _archived/ files back to original paths
      +---> Rename server keys back to original names
      +---> Remove ccaudit-stale frontmatter
      |
      v
  Update/delete manifest
```

### Data flow constraints

1. **Phases 1-4 are strictly read-only.** No filesystem writes. This is the v1.0 scope.
2. **Phases 1 and 2 can run in parallel.** Session Discovery and Config Scanner are independent.
3. **Phase 5 requires explicit `--dry-run` flag.** Single file write only.
4. **Phase 6 is gated by checkpoint validation.** Hash must match. Triple user confirmation required.
5. **Phase 7 reads the restore manifest** written by Phase 6 -- it does not recompute the ghost report.
6. **Manifest is written incrementally** during Phase 6 -- each operation appended on completion, enabling partial restore after crashes.

---

## Monorepo Structure

```
ccaudit-aka-ghostbuster/
|
+-- packages/
|   |
|   +-- internal/                    # @ccaudit/internal (private: true)
|   |   +-- src/
|   |   |   +-- discovery/
|   |   |   |   +-- index.ts         # discoverSessionFiles(), discoverSubagentSessions()
|   |   |   |   +-- paths.ts         # resolveClaudePaths(), XDG/legacy/env resolution
|   |   |   |
|   |   |   +-- parser/
|   |   |   |   +-- index.ts         # parseSessionFile() async generator
|   |   |   |   +-- schemas.ts       # Valibot schemas for JSONL message types
|   |   |   |   +-- extractors/
|   |   |   |       +-- agent.ts     # extractAgentInvocations()
|   |   |   |       +-- skill.ts     # extractSkillInvocations()
|   |   |   |       +-- mcp.ts       # extractMcpInvocations()
|   |   |   |       +-- index.ts     # extractAllInvocations() dispatcher
|   |   |   |
|   |   |   +-- ledger/
|   |   |   |   +-- index.ts         # buildLedger(), filterByTimeWindow()
|   |   |   |   +-- types.ts         # LedgerEntry, McpServerEntry
|   |   |   |
|   |   |   +-- scanner/
|   |   |   |   +-- index.ts         # scanInstalledInventory()
|   |   |   |   +-- agents.ts        # scanAgents()
|   |   |   |   +-- skills.ts        # scanSkills()
|   |   |   |   +-- mcp.ts           # scanMcpServers() -- reads ~/.claude.json + .mcp.json
|   |   |   |   +-- memory.ts        # scanMemoryFiles()
|   |   |   |
|   |   |   +-- detector/
|   |   |   |   +-- index.ts         # detectGhosts()
|   |   |   |   +-- token-estimates.ts  # lookupTokenCost()
|   |   |   |
|   |   |   +-- types.ts             # Shared type definitions (all interfaces above)
|   |   |   +-- index.ts             # Public API barrel export
|   |   |
|   |   +-- data/
|   |   |   +-- mcp-token-estimates.json  # Community-maintained token cost data
|   |   |
|   |   +-- package.json
|   |   +-- tsconfig.json
|   |
|   +-- terminal/                    # @ccaudit/terminal (private: true)
|       +-- src/
|       |   +-- table.ts             # GhostTable, InventoryTable (cli-table3 wrappers)
|       |   +-- formatters.ts        # formatTokenCount(), formatDate(), formatDuration()
|       |   +-- colors.ts            # ghost(), used(), header() ANSI helpers
|       |   +-- responsive.ts        # getTerminalWidth(), isCompactMode()
|       |   +-- json.ts              # renderJson()
|       |   +-- csv.ts               # renderCsv()
|       |   +-- index.ts             # barrel export
|       |
|       +-- package.json
|       +-- tsconfig.json
|
+-- apps/
|   |
|   +-- ccaudit/                     # Main CLI application
|   |   +-- src/
|   |   |   +-- cli/
|   |   |   |   +-- index.ts         # gunshi CLI entry, default command routing
|   |   |   |   +-- commands/
|   |   |   |       +-- ghost.ts     # Default: full ghost report
|   |   |   |       +-- inventory.ts # All defined items
|   |   |   |       +-- mcp.ts       # MCP-focused view (+ --live)
|   |   |   |       +-- trend.ts     # Usage over time
|   |   |   |       +-- restore.ts   # Rollback operations (v1.2)
|   |   |   |       +-- contribute.ts  # PR payload generation (v1.2+)
|   |   |   |
|   |   |   +-- remediation/         # v1.1+ filesystem mutation
|   |   |   |   +-- checkpoint.ts    # createCheckpoint(), validateCheckpoint()
|   |   |   |   +-- hash.ts          # computeInventoryHash() -- SHA-256
|   |   |   |   +-- archive.ts       # archiveItem(), handles _archived/ + name collisions
|   |   |   |   +-- mcp-disabler.ts  # disableMcpServer(), key-rename strategy
|   |   |   |   +-- memory-flagger.ts  # flagStaleMemory(), frontmatter injection
|   |   |   |   +-- restore.ts       # restoreAll(), restoreItem()
|   |   |   |   +-- manifest.ts      # readManifest(), appendOperation(), removeOperation()
|   |   |   |   +-- types.ts         # Checkpoint, RestoreManifest, RestoreOperation
|   |   |   |
|   |   |   +-- pipeline.ts          # Orchestrates: discover -> parse -> detect -> render
|   |   |   +-- index.ts             # bin entry point
|   |   |
|   |   +-- package.json
|   |   +-- tsdown.config.ts
|   |
|   +-- ccaudit-mcp/                 # Future MCP server (v2+)
|       +-- src/
|       |   +-- ... (reuses @ccaudit/internal, returns structured data)
|       +-- package.json
|
+-- docs/                            # VitePress documentation site
+-- .planning/                       # Planning artifacts (not shipped)
+-- pnpm-workspace.yaml
+-- package.json                     # Root workspace config
+-- tsconfig.json                    # Root TypeScript config
```

### Package Dependency Graph

```
apps/ccaudit
  |-- devDependencies --> @ccaudit/internal (workspace:*)
  |-- devDependencies --> @ccaudit/terminal (workspace:*)
  |-- devDependencies --> gunshi
  |   (bundled by tsdown, zero runtime deps)

packages/terminal
  |-- devDependencies --> cli-table3
  |   (no dependency on @ccaudit/internal -- receives typed data via function args)

packages/internal
  |-- devDependencies --> valibot
  |-- devDependencies --> tinyglobby
  |   (no dependency on terminal or apps)

apps/ccaudit-mcp (future)
  |-- dependencies --> @ccaudit/internal (workspace:*)  # runtime, not bundled
  |-- dependencies --> @ccaudit/terminal (workspace:*)  # runtime, not bundled
```

**Rule:** `packages/internal` NEVER depends on `packages/terminal` or `apps/*`. Data flows up (internal -> apps), types are defined in internal and consumed everywhere.

**Why all devDependencies for CLI apps:** Following ccusage's pattern. `tsdown` bundles everything into a single self-contained file. The published npm package declares zero `dependencies`. This gives: faster `npx` cold starts, no dependency resolution failures, no supply-chain attack surface at runtime. The MCP server is the exception -- it declares packages as runtime `dependencies` because it reuses them at runtime (same pattern as `@ccusage/mcp`).

### Boundary Rationale

| Component | Location | Why There, Not Elsewhere |
|-----------|----------|--------------------------|
| Discovery, Parser, Ledger, Scanner, Detector | `packages/internal` | Shared between CLI and future MCP server. Pure data operations with no UI or mutation. |
| Table rendering, formatters, colors | `packages/terminal` | Terminal-specific output. MCP server returns structured data and will not need this. Isolated for future TUI tools. |
| CLI router, commands | `apps/ccaudit/src/cli/` | App-specific command wiring. Only the CLI needs gunshi. |
| Remediation engine | `apps/ccaudit/src/remediation/` | Filesystem mutation is app-specific policy. Shared packages must remain side-effect-free. The MCP server must never mutate files. |
| Pipeline orchestrator | `apps/ccaudit/src/pipeline.ts` | Composes shared components into CLI-specific flow. Different apps may compose differently. |

---

## Rollback Architecture

Remediation is the highest-risk operation in ccaudit. The architecture must make data loss structurally impossible, not just unlikely.

### Principles

1. **Archive, never delete.** Agents and skills move to `_archived/` subdirectories, never removed from disk.
2. **Rename, never remove.** MCP server entries are disabled by key-rename in config, never deleted from JSON.
3. **Flag, never move.** Memory files get a frontmatter annotation, never relocated.
4. **Checkpoint-gated.** Remediation requires a valid checkpoint with matching inventory hash.
5. **Manifest-driven restore.** Every remediation writes a machine-readable manifest that the restore command reads verbatim.
6. **Incremental manifest.** Operations are appended to the manifest as they complete -- a crash after 3 of 5 operations still allows restoring those 3.

### Checkpoint System

```typescript
interface Checkpoint {
  version: 1;
  createdAt: string;              // ISO 8601
  inventoryHash: string;          // SHA-256 of sorted inventory state
  ghostReport: {
    agentCount: number;
    skillCount: number;
    mcpServerCount: number;
    memoryFileCount: number;
    totalTokenWaste: number;
  };
}
```

**Storage location:** `~/.claude/ccaudit/.last-dry-run` (JSON file)

**Hash computation algorithm:**
1. Collect all file paths for agents, skills, memory files -- sorted alphabetically
2. Collect all MCP server names from config files -- sorted alphabetically
3. For each file: append `path + ':' + mtime_ms` to hash input
4. For each MCP server: append `name + ':' + JSON.stringify(config, null, 0)` to hash input
5. Join all entries with `\n`
6. Compute SHA-256 of the resulting string using `node:crypto`

**Hash changes when:**
- Any agent/skill/memory file is added, removed, or modified (mtime changes)
- Any MCP server is added, removed, or its config changes

**Hash does NOT change when:**
- Session JSONL files change (read-only inputs, not inventory)
- ccaudit's own config changes

**Why hash-based, not time-based:** A 5-minute-old dry-run is invalid if the user added an agent since then. A 3-day-old dry-run is perfectly valid if nothing has changed. Time-based expiry gets this backwards. The hash captures the only thing that matters: whether the inventory state that was audited still matches the current filesystem reality.

### Remediation Operations

**Agent/Skill Archival:**
```
~/.claude/agents/my-agent.md
  --> moves to -->
~/.claude/agents/_archived/my-agent.md
```
- Creates `_archived/` subdirectory if it does not exist
- If a file with the same name already exists in `_archived/`, appends numeric suffix: `my-agent.1.md`, `my-agent.2.md`, etc.
- Preserves original file permissions and modification time

**MCP Server Disabling:**

MCP config files (`~/.claude.json`, `.mcp.json`) are plain JSON, not JSONC. Cannot use `//` comments. Strategy: rename the server key with a `ccaudit-disabled:` prefix.

```json
{
  "mcpServers": {
    "ccaudit-disabled:context7": { "command": "npx", "args": ["-y", "@anthropic/context7-mcp"] }
  }
}
```

This approach:
- Preserves full server config verbatim (all args, env, type)
- Is machine-readable for automated restore
- Claude Code ignores unrecognized key names (server with prefix does not match any tool pattern)
- Maintains valid JSON at all times
- Atomic write: read -> parse -> modify in-memory -> write to temp file -> `rename()` over original

**Memory File Flagging:**
```markdown
---
ccaudit-stale: true
ccaudit-flagged-at: 2026-04-03T12:00:00Z
---
# Original content below, untouched
```
- Prepends YAML frontmatter block if none exists
- Adds `ccaudit-stale: true` to existing frontmatter if already present
- Original content is never modified

### Restore Manifest

Written incrementally during remediation to `~/.claude/ccaudit/.last-bust`.

```typescript
interface RestoreManifest {
  version: 1;
  executedAt: string;              // ISO 8601
  checkpoint: Checkpoint;          // The checkpoint that was validated
  operations: RestoreOperation[];  // Appended one at a time
}

type RestoreOperation =
  | { type: 'archive'; itemType: 'agent' | 'skill'; originalPath: string; archivedPath: string }
  | { type: 'mcp-disable'; configPath: string; serverName: string; disabledKey: string }
  | { type: 'memory-flag'; filePath: string; hadExistingFrontmatter: boolean };
```

**Restore process (full):**
1. Read manifest from `~/.claude/ccaudit/.last-bust`
2. For each operation in reverse order:
   - `archive`: Move file from `archivedPath` back to `originalPath`
   - `mcp-disable`: Rename `ccaudit-disabled:<serverName>` back to `<serverName>` in config
   - `memory-flag`: Remove `ccaudit-stale` and `ccaudit-flagged-at` from frontmatter (remove entire block if it was not present before)
3. Delete manifest file after all operations succeed

**Restore process (single item: `restore <name>`):**
1. Read manifest
2. Find operations matching `<name>` (by agent/skill filename or MCP server name)
3. Execute only those operations
4. Rewrite manifest with remaining operations (or delete if empty)

**Restore process (list: `restore --list`):**
1. Read manifest
2. Display all archived items with their original paths and archive dates

### Safety Guarantees

| Risk | Mitigation |
|------|------------|
| User runs bust without understanding | Triple confirmation prompt + literal "I accept full responsibility" text input |
| State changed between dry-run and bust | Hash-based checkpoint validation rejects stale checkpoints immediately |
| Remediation crashes mid-operation | Manifest written incrementally -- each operation appended on success. Partial manifest enables partial restore. |
| Archived file name collision | Numeric suffix appended (`.1.md`, `.2.md`, etc.) |
| Config file corrupted during MCP disable | Atomic write pattern: write to temp file, then `fs.rename()` over original (atomic on POSIX) |
| Restore fails mid-operation | Operations removed from manifest as they succeed. Remaining operations still restorable. |
| User deletes `_archived/` directory | Restore detects missing files and reports them. Does not throw -- reports what could and could not be restored. |
| Concurrent ccaudit runs | Checkpoint hash mismatch if other instance modified inventory. First instance's checkpoint becomes invalid. |

---

## Build Order

Each phase produces a working (if incomplete) tool. Dependencies between phases are strict -- later phases import earlier phases' outputs.

### Phase 1: Foundation
**Build:** Monorepo scaffold + shared types + CLI skeleton
- `pnpm-workspace.yaml`, root `package.json`, root `tsconfig.json`
- `packages/internal/` with `types.ts` and barrel export
- `packages/terminal/` with stub table renderer
- `apps/ccaudit/` with gunshi CLI skeleton routing to stub commands
- `tsdown` build config producing a runnable (but no-op) `npx ccaudit`
- Vitest setup with in-source testing pattern (`if (import.meta.vitest)`)

**Dependencies:** None. Foundation layer.
**Validates:** Build pipeline, monorepo resolution, CLI routing, `npx` execution.

### Phase 2: Discovery + Parsing
**Build:** Session Discovery + JSONL Parser + Invocation Extractors
- `packages/internal/src/discovery/` -- find session files across both path layouts
- `packages/internal/src/parser/` -- async generator JSONL parser with valibot validation
- `packages/internal/src/parser/extractors/` -- agent, skill, MCP pattern matchers
- Valibot schemas for JSONL message structure
- Unit tests with JSONL fixture data (anonymized real sessions)

**Dependencies:** Phase 1 types.
**Validates:** Finds real Claude Code session files. Extractors correctly identify agents, skills, MCP tools from actual JSONL data.

### Phase 3: Ledger + Scanner
**Build:** Invocation Ledger + Config Scanner
- `packages/internal/src/ledger/` -- aggregate events, `--since` time filtering, deduplication
- `packages/internal/src/scanner/` -- scan agents, skills, MCP config (`~/.claude.json` + `.mcp.json`), memory files
- Unit tests for aggregation logic and scanner discovery across both path layouts

**Dependencies:** Phase 2 parser output.
**Validates:** Ledger correctly counts invocations. Scanner finds all installed items. Time filtering works.

### Phase 4: Ghost Detection + Rendering (v1.0 feature-complete)
**Build:** Ghost Detector + Report Renderer + Pipeline Orchestrator + all v1.0 commands
- `packages/internal/src/detector/` -- set-difference comparison, token estimates lookup
- `packages/internal/data/mcp-token-estimates.json` -- initial community estimates
- `packages/terminal/src/` -- full table rendering with responsive layout, JSON/CSV output
- `apps/ccaudit/src/pipeline.ts` -- compose all components into the analysis pipeline
- `apps/ccaudit/src/cli/commands/ghost.ts` (default), `inventory.ts`, `mcp.ts`, `trend.ts`
- `--json`, `--csv`, `--since` flags fully wired
- Integration tests against real session data
- Exit code behavior (0 = no ghosts, 1 = ghosts found)

**Dependencies:** Phases 2 + 3.
**Validates:** Full ghost report renders correctly. Token waste estimates appear. All output modes and commands work. **This is the v1.0 release milestone.**

### Phase 5: Checkpoint + Dry-Run (v1.1)
**Build:** Checkpoint Manager + `--dry-run` flag
- `apps/ccaudit/src/remediation/checkpoint.ts` -- SHA-256 hash computation, checkpoint I/O
- `apps/ccaudit/src/remediation/hash.ts` -- deterministic inventory hashing
- Wire `--dry-run` flag to ghost command
- Write checkpoint to `~/.claude/ccaudit/.last-dry-run`
- Display remediation plan to stdout without executing any changes

**Dependencies:** Phase 4 (needs GhostReport + InstalledInventory to compute checkpoint hash).
**Validates:** Hash is deterministic (same input = same hash). Dry-run output matches what remediation would do.

### Phase 6: Remediation + Restore (v1.2)
**Build:** Full remediation engine and restore system
- `apps/ccaudit/src/remediation/archive.ts` -- agent/skill archival with collision handling
- `apps/ccaudit/src/remediation/mcp-disabler.ts` -- key-rename strategy with atomic writes
- `apps/ccaudit/src/remediation/memory-flagger.ts` -- frontmatter injection/modification
- `apps/ccaudit/src/remediation/manifest.ts` -- incremental manifest I/O
- `apps/ccaudit/src/remediation/restore.ts` -- full, partial, and list restore
- `apps/ccaudit/src/cli/commands/restore.ts` -- restore command with subcommands
- `--dangerously-bust-ghosts` flag with triple confirmation flow
- Checkpoint validation (hash comparison) before any mutation
- Integration tests: full bust-then-restore cycle, verify byte-identical state
- Partial restore tests, stale checkpoint rejection tests

**Dependencies:** Phase 5 checkpoint system.
**Validates:** Full remediation cycle works end-to-end. Restore produces identical files. Partial restore works. Checkpoint rejection works when state has changed.

### Phase 7: Polish + Contribute (v1.2+)
**Build:** Contribute command, live MCP, documentation, hardening
- `apps/ccaudit/src/cli/commands/contribute.ts` -- generate PR payload for `mcp-token-estimates.json`
- `ccaudit mcp --live` -- live MCP connection for exact (not estimated) token counts
- `docs/` -- VitePress documentation site
- Edge case hardening: empty sessions, missing config dirs, permission errors, symlinks, concurrent access

**Dependencies:** All prior phases.
**Validates:** Contribute workflow produces valid PR payload. Live MCP connection works. Documentation is accurate and complete.

---

## Key Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Pipeline over object graph** | Data flows linearly: discover -> parse -> ledger -> detect -> render. No component reaches back to query an earlier stage. Each stage is independently testable. ccusage uses this exact pattern. |
| 2 | **Shared packages are read-only** | `packages/internal` and `packages/terminal` perform zero filesystem writes. All mutation lives in `apps/ccaudit/src/remediation/`. The MCP server shares the analysis pipeline but must never mutate files -- this is structural, not conventional. |
| 3 | **valibot.safeParse everywhere** | JSONL schema is not under our control. One malformed line must not crash the tool. `safeParse` returns a discriminated union forcing explicit handling. |
| 4 | **Async generators for JSONL** | `node:readline` over `createReadStream()` gives constant-memory parsing. Session files can be 100MB+ for power users. Generators compose naturally with the pipeline pattern. |
| 5 | **MCP disable via key-rename** | Config files are plain JSON (not JSONC). Key-renaming (`ccaudit-disabled:name`) preserves valid JSON, is machine-readable, and Claude Code ignores unrecognized keys. |
| 6 | **Hash-based checkpoint** | Time-based expiry is wrong -- a fresh checkpoint is invalid if inventory changed, and a stale checkpoint is valid if it has not. The SHA-256 hash captures the actual invariant. |
| 7 | **Incremental manifest** | Operations appended to manifest as they complete. Crash after partial remediation still allows partial restore. Writing manifest only at the end would lose track of what changed. |
| 8 | **Atomic config writes** | Write to temp file, then `fs.rename()`. Atomic on POSIX. Prevents corrupting `~/.claude.json` if process is interrupted mid-write -- a corrupted config would break all of Claude Code. |
| 9 | **Zero runtime deps via tsdown** | All packages as devDependencies, bundled into single file. Zero `dependencies` in published package. Faster npx cold starts, no supply-chain attack surface, no resolution failures. |
| 10 | **Schema-first types with valibot** | Define valibot schemas, infer TypeScript types via `v.InferOutput<>`. Single source of truth for runtime validation and compile-time types. |

## Patterns to Follow

### Pattern: Command Handler as Thin Orchestrator

gunshi command handlers should be thin wrappers that call into packages. Business logic stays in packages (testable, reusable by MCP server). Commands handle only I/O and formatting.

```typescript
// apps/ccaudit/src/cli/commands/ghost.ts
const ghostCommand = defineCommand({
  name: 'ghost',
  args: { since: { type: 'string', default: '7d' } },
  run: async ({ args }) => {
    const files = await discoverSessionFiles();      // packages/internal
    const inventory = await scanInstalledInventory(); // packages/internal
    const ledger = await buildLedger(files, args.since); // packages/internal
    const report = detectGhosts(ledger, inventory);  // packages/internal
    renderReport(report, args);                      // packages/terminal
    process.exitCode = report.summary.totalGhost > 0 ? 1 : 0;
  },
});
```

### Pattern: Dual Path Resolution

Always check both XDG and legacy paths. Both are scanned (not either/or).

```typescript
function resolveClaudePaths(): string[] {
  const home = homedir();
  const paths = [
    join(home, '.config', 'claude'),  // XDG
    join(home, '.claude'),            // legacy
  ];
  if (process.env.CLAUDE_CONFIG_DIR) {
    paths.unshift(process.env.CLAUDE_CONFIG_DIR);
  }
  return paths.filter(p => existsSync(p));
}
```

### Pattern: Schema-First with Valibot

```typescript
const ToolUseSchema = v.object({
  type: v.literal('tool_use'),
  name: v.string(),
  input: v.record(v.string(), v.unknown()),
});
type ToolUse = v.InferOutput<typeof ToolUseSchema>;
```

## Anti-Patterns to Avoid

| Anti-Pattern | Why Bad | Instead |
|-------------|---------|---------|
| Loading all JSONL into memory | OOM risk on large session files | Async generators with `node:readline` |
| Business logic in command handlers | Untestable, not reusable by MCP server | Thin orchestrators, logic in `packages/internal` |
| Throwing on invalid JSONL data | One bad line kills entire audit | `safeParse` + `continue`, log in `--verbose` |
| String path concatenation | Breaks on Windows | Always `path.join()` |
| `packages/terminal` importing `packages/internal` internals | Deep coupling | Terminal receives typed data via function arguments, imports only types |
| Direct config file writes | Corruption risk on interruption | Atomic write: temp file then `fs.rename()` |

---

## Sources

- [ccusage GitHub](https://github.com/ryoppippi/ccusage) -- monorepo layout, gunshi CLI, tsdown bundling, @ccusage/internal + @ccusage/terminal split
- [ccusage DeepWiki](https://deepwiki.com/ryoppippi/ccusage) -- detailed architecture, pipeline composition, CLI command structure, ResponsiveTable pattern
- [ccboard GitHub](https://github.com/FlorianBruniaux/ccboard) -- JSONL parsing patterns, agent/MCP extraction from session data
- [gunshi documentation](https://gunshi.dev/) -- CLI framework: command routing, subcommands, type-safe args
- [tsdown documentation](https://tsdown.dev/options/dependencies) -- devDependencies bundling behavior
- [valibot safeParse](https://valibot.dev/api/safeParse/) -- non-throwing validation pattern
- [Claude Code settings docs](https://code.claude.com/docs/en/settings) -- settings.json scope and precedence
- [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) -- MCP server config in ~/.claude.json and .mcp.json
- [tinyglobby npm](https://www.npmjs.com/package/tinyglobby) -- lightweight async glob
- [cli-table3 GitHub](https://github.com/cli-table/cli-table3) -- terminal table rendering
- [@praha/byethrow](https://www.npmjs.com/package/@praha/byethrow) -- Result type pattern (referenced, not necessarily adopted)
- [ryoppippi CLI stack blog](https://ryoppippi.com/blog/2025-08-12-my-js-cli-stack-2025-en) -- gunshi + tsdown rationale from ccusage author

---

**Confidence: HIGH**

Architecture grounded in ccusage's proven patterns (same monorepo layout, bundler, CLI framework, shared-package split). JSONL schema confirmed from local file inspection. MCP config file locations verified against official Claude Code documentation. Rollback architecture uses established filesystem safety patterns (atomic writes, incremental manifests, archive-not-delete). One MEDIUM-confidence area: the `ccaudit-disabled:` key-rename strategy for MCP servers needs runtime validation that Claude Code ignores unrecognized keys in `mcpServers` (highly likely but not explicitly documented).

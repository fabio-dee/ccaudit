# Code Study: agent-usage-analyzer — Signal Detection

## Executive Summary

**Language**: TypeScript (Node.js 22+)
**Purpose**: Count structured skill, tool, command, and MCP invocations from local session exports (Codex and Claude Code)

### Architecture
- CLI entry point: `scripts/analyze.mjs` → compiled from `src/cli/analyze.ts`
- Core analyzer: `src/lib/analyze.ts` orchestrates the flow
- Extraction engine: `src/lib/extract.ts` (JSONL/JSON field parsing)
- Signal detection: `src/lib/normalize.ts` (invocation kind inference)
- Aggregation: `src/lib/aggregate.ts` (counting and deduplication)
- Providers: `src/lib/providers.ts` (format-specific synthesis)

---

## 1. JSONL/JSON Fields Parsed

### Top-Level Session Fields
**File**: `src/lib/extract.ts:512-597`

```typescript
// Session ID
['sessionId'], ['session_id'], ['id'], ['metadata', 'sessionId']

// Agent identification
['agent'], ['agentName'], ['metadata', 'agent']

// Source/Provider
['source'], ['provider'], ['metadata', 'source']

// Working directory
['cwd'], ['workingDirectory'], ['working_directory'], ['metadata', 'cwd']

// Timestamps
['createdAt'], ['created_at'], ['startedAt'], ['metadata', 'createdAt']
['updatedAt'], ['updated_at'], ['endedAt'], ['metadata', 'updatedAt']
```

### Invocation Data Extraction — 3 Priority Paths

**Path 1: Summary-based** (highest confidence) — `src/lib/extract.ts:25-32`
```typescript
SUMMARY_PATHS = [
  ['usageSummary'], ['usage_summary'],
  ['invocationSummary'], ['invocation_summary'],
  ['summary', 'usage'], ['summary', 'invocations']
]
// Inside summary: invocations, items, entries, actions, calls
// Typed buckets: tools, skills, commands, mcp, mcpActions, mcp_actions
```

**Path 2: Raw Events** (high confidence) — `src/lib/extract.ts:34-42`
```typescript
EVENT_PATHS = [
  ['events'], ['invocations'], ['rawEvents'], ['raw_events'],
  ['activity', 'events'], ['toolCalls'], ['tool_calls']
]
```

**Path 3: Heuristic Activity Blocks** (low confidence) — `src/lib/extract.ts:44-52`
```typescript
ACTIVITY_PATHS = [
  ['structuredActivityBlock'], ['structured_activity_block'],
  ['toolActivity'], ['tool_activity'],
  ['activityBlock'], ['activity_block'], ['toolActivityBlock']
]
// Pattern: /^(skill|tool|command|mcp|unknown)\s*[:|]\s*(.+?)\s+x(\d+)/
```

### Nested Invocation Record Fields
**File**: `src/lib/extract.ts:139-196` (`parseInvocationLike`)

```typescript
// Name (priority order)
['rawName'], ['raw_name'], ['name'],
['tool'], ['toolName'], ['tool_name'],
['skill'], ['skillName'], ['skill_name'],
['command'], ['commandName'], ['command_name'],
['action'], ['actionName'], ['action_name'],
['invocation'], ['id'], ['key']

// Kind
['kind'], ['type'], ['eventType'], ['event_type'], ['category']

// Count
['count'], ['uses'], ['invocations'], ['total']

// Sample
['sample'], ['preview'], ['commandPreview'], ['example']
```

---

## 2. Invocation Counting & Aggregation

### Per-Session Counting
**File**: `src/lib/extract.ts:118-120`
```typescript
function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}
```
Each invocation defaults to count=1 if missing.

### Aggregation Process
**File**: `src/lib/aggregate.ts:78-150`

1. **Canonical Key**: `"skill:repo-summary"` or `"mcp/github/list_issues"`
2. **Bucket tracking**: `invocationCount`, `sessionIds` (Set), `topAgents` (Map), `topSources` (Map), `aliases` (Set), `samples` (Set, max 3)
3. **Session dedup**: Sessions counted once per unique sessionId
4. **Percent**: `(sessionCount / countedSessions) * 100`

### Output Structure (`AggregateRow`)
**File**: `src/types.ts:66-77`
```typescript
{
  canonicalKey: string;    // "skill:repo-summary"
  canonicalName: string;   // "repo-summary"
  kind: InvocationKind;
  invocationCount: number;
  sessionCount: number;
  percentSessions: number;
  aliases: string[];
  topAgents: Array<{name, count}>;
  topSources: Array<{name, count}>;
  samples?: string[];
}
```

---

## 3. Signal Types Detected

### Core Kinds
**File**: `src/types.ts:2`
```typescript
INVOCATION_KINDS = ['skill', 'tool', 'command', 'mcp', 'unknown']
```

### Kind Inference Logic
**File**: `src/lib/normalize.ts:46-96`

Priority order:
1. **Explicit kind** if provided in JSON
2. **Name-based heuristics**:
   - `mcp:` or `mcp/` prefix → `'mcp'`
   - `skill:` prefix → `'skill'`
   - `/` prefix or `command:` → `'command'`
   - `tool:` prefix → `'tool'`
   - Known built-in tools → `'tool'`
3. **Type hint analysis**: contains "tool"/"skill"/"command"/"mcp"
4. **Default**: `'unknown'`

### Known Built-in Tools
**File**: `src/lib/normalize.ts:3-15`
```
apply_patch, bash, edit, edit_file, read, read_file,
run_shell, search, terminal, web_fetch, web_search
```

### Type Coercion
**File**: `src/lib/normalize.ts:21-40`
```
"slash_command" → 'command'
"tool_call" → 'tool'
"mcp_action" → 'mcp'
```

---

## 4. Provider-Specific Parsing

### Claude Project Sessions (.jsonl)
**File**: `src/lib/providers.ts:227-301`

- Entry type `"assistant"` with `message.content[].type === "tool_use"`
- Extracts `name`, detects MCP if starts with `mcp__`
- Skill activations via regex: `/(?:[A-Za-z]:)?[^"'\`\s]*skills\/[^"'\`\s]+\/SKILL\.md/g`
- Per-turn deduplication for skills

### Codex Archived Event Logs (.jsonl)
**File**: `src/lib/providers.ts:303-397`

- Entry type `"response_item"` with `payload.type === "function_call"`
- Extracts `payload.name`, detects MCP with `mcp__` prefix
- Same skill activation regex

---

## 5. Name Normalization & Aliases

### Canonical Name Normalization
**File**: `src/lib/normalize.ts:98-128`

```
"Bash" → "bash"
"/repo-summary" → "repo-summary"
"mcp__github__list_issues" → "mcp/github/list_issues"
"mcp:github:list_issues" → "mcp/github/list_issues"
```

Key: MCP `__` (double underscore) → `/` in canonical form.

### Alias Resolution
**File**: `src/lib/aliases.ts`

Loads from YAML/JSON, maps raw names to canonical:
```yaml
bash:
  kind: tool
  aliases: [Bash, terminal, run_shell]

mcp/github/list_issues:
  kind: mcp
  aliases: [mcp:github:list_issues, github-mcp-server-list_issues]
```

---

## 6. Conflict & Partial Handling

### Extraction Mode Priority
**File**: `src/lib/extract.ts:537-540`

1. Structured Summary (highest)
2. Raw Events
3. Structured Activity Block (lowest, always marked partial)
4. None (no data)

### Contradiction Detection
**File**: `src/lib/extract.ts:542-554`

When both `usageSummary` AND `events` exist and disagree:
- Strict mode: skip entire session
- Normal mode: use summary, warn about contradiction

### Partial Indicators
```typescript
['partial'], ['isPartial'], ['truncated'], ['incomplete'], ['metadata', 'partial']
value.complete === false (inside usageSummary)
```

---

## 7. Signals ccaudit Might Be Missing

1. **Agent spawns partially detected**: `subagent_type` field exists in `tool_use.input` for `name === "Agent"` but is NOT extracted as a separate signal — only the "Agent" tool invocation itself is counted
2. **MCP prefix variations**: Only `mcp__` detected in raw extraction; `mcp-` (hyphen) and `mcp:` (colon) handled in normalization but not prefix detection
3. **Skill activation via SKILL.md paths**: Regex-based detection in tool arguments — ccaudit should consider this heuristic
4. **Per-turn deduplication**: Skills deduplicated per user turn, not just per session
5. **Coverage reporting**: Explicit tracking of matched/counted/partial/heuristic/skipped session counts
6. **Alias resolution**: External alias files for normalizing tool name variants

---

## 8. Key Takeaways for ccaudit

### Adopt
- **Canonical key format** (`kind:name`) for aggregation
- **MCP `__` → `/` normalization** for display
- **Count defaulting to 1** when not specified
- **Session-level deduplication** via sessionId Set
- **Coverage reporting** (how many sessions had data vs didn't)

### Avoid
- **Over-engineering extraction paths**: We know Claude Code JSONL format — we don't need 3 fallback extraction modes for unknown formats
- **Activity block heuristic parsing**: Fragile text parsing with regex
- **No dedicated agent spawn signal**: They missed this — we should track it explicitly

### Novel signals to consider
- **Skill activations via argument inspection** (SKILL.md path regex)
- **Contradiction detection** between multiple data sources
- **Partial session tracking** for data quality reporting

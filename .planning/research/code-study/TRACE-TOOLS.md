# Code Study: claude-code-trace (Rust) + cc-trace (Go) — MCP Parsing + Hook Schema

## Executive Summary

Two trace tools that capture Claude Code tool invocations from different angles:
- **claude-code-trace** (Rust/Tauri): Post-hoc JSONL parsing with desktop UI
- **cc-trace** (Go): Real-time hook event capture with OpenTelemetry export

Together they confirm the `mcp__<server>__<tool>` naming convention and reveal hook event schemas unavailable in JSONL alone.

---

## 1. MCP Parsing — claude-code-trace (Rust)

### Split Logic
**File**: `src-tauri/src/parser/taxonomy.rs` (lines 50-61)

```rust
fn parse_mcp_name(name: &str) -> Option<(&str, &str)> {
    let rest = name.strip_prefix("mcp__")?;
    let idx = rest.find("__")?;
    let server = &rest[..idx];
    let tool = &rest[idx + 2..];
    Some((server, tool))
}
```

**Confirmed**:
- Prefix is always `mcp__` (double underscore)
- Server and tool separated by `__` (double underscore)
- `mcp__figma__get_design_context` → `("figma", "get_design_context")`
- Returns `Option` — gracefully handles non-MCP tool names

### JSONL Entry Structure
**File**: `src-tauri/src/parser/entry.rs` (lines 6-61)

Top-level fields parsed:
- `type` (entry_type) — message type identifier
- `message.content` — array of content blocks
- `toolUseResult` — tool execution result
- `sourceToolUseID` — links result to tool_use
- `hookEvent`, `hookName` — hook-related metadata
- `attachment` — hook result payloads

### Tool Extraction from Content Blocks
**File**: `src-tauri/src/parser/classify.rs` (lines 530-606)

```rust
// Loops through message.content array
// Matches blocks where type === "tool_use"
// Extracts: id, name, input (kept as JSON Value)
// Creates ContentBlock with tool_id, tool_name, tool_input
```

Tool classification by name:
1. `mcp__` prefix → MCP tool
2. Known built-in names → Native tool (Read, Write, Edit, Bash, etc.)
3. `Task` → Agent spawn
4. `Skill` → Skill invocation

---

## 2. Hook Event Schema — cc-trace (Go)

### PostToolUse Payload
**File**: `internal/hook/types.go`

```go
type HookBase struct {
    SessionID      string `json:"session_id"`
    TranscriptPath string `json:"transcript_path"`
    Cwd            string `json:"cwd"`
    PermissionMode string `json:"permission_mode"`
    HookEventName  string `json:"hook_event_name"`
}

type PostToolUsePayload struct {
    HookBase
    ToolName     string         `json:"tool_name"`
    ToolInput    map[string]any `json:"tool_input"`
    ToolResponse any            `json:"tool_response"`
    ToolUseID    string         `json:"tool_use_id"`
}
```

### PostToolUseFailure Payload
```go
type PostToolUseFailurePayload struct {
    HookBase
    ToolName     string         `json:"tool_name"`
    ToolInput    map[string]any `json:"tool_input"`
    ToolResponse any            `json:"tool_response"`
    ToolUseID    string         `json:"tool_use_id"`
    Error        string         `json:"error"`
    IsInterrupt  bool           `json:"is_interrupt"`
    AgentID      string         `json:"agent_id,omitempty"`
    AgentType    string         `json:"agent_type,omitempty"`
}
```

### SubagentStop Payload
```go
type SubagentStopPayload struct {
    HookBase
    AgentID              string `json:"agent_id"`
    AgentType            string `json:"agent_type"`
    AgentTranscriptPath  string `json:"agent_transcript_path"`
    LastAssistantMessage string `json:"last_assistant_message"`
    StopHookActive       bool   `json:"stop_hook_active"`
}
```

### Transcript Parsing (Turn-Based)
**File**: `internal/transcript/parse.go` (lines 289-325)

- Parses JSONL lines sequentially into Turn objects
- Builds turns from user → assistant → tool_results → next user pattern
- Matches `tool_use` blocks with `tool_result` blocks by `tool_use_id`
- ToolCall struct: `Name`, `ID`, `Input`, `Output`, `Success`, `StartTime`, `EndTime`

---

## 3. Key Discrepancies Between Implementations

| Aspect | claude-code-trace (Rust) | cc-trace (Go) |
|--------|--------------------------|---------------|
| **Data source** | JSONL file parsing (post-hoc) | Hook events (real-time) |
| **Field naming** | `id`, `name`, `input` in tool_use blocks | `tool_name`, `tool_use_id`, `tool_input` at top level |
| **Tool response** | From JSONL `tool_result.content` (string) | From hook `tool_response` (any type) |
| **Subagent context** | Not explicitly modeled | Explicit via `agent_id`/`agent_type` + SubagentStop |
| **Hook events** | Post-hoc from debug log | Real-time payloads with structured fields |

---

## 4. Fields Available in Hooks but NOT in JSONL

These fields are only available via Claude Code hooks, not in JSONL session logs:

| Hook Field | Purpose | Relevance to ccaudit |
|-----------|---------|---------------------|
| `permission_mode` | Current permission mode | LOW — not relevant to ghost detection |
| `tool_response` | Full tool output | LOW — too large, not needed |
| `error` | Error message on failure | MEDIUM — could track failed tool calls |
| `is_interrupt` | Whether user interrupted | LOW |
| `agent_id` | Subagent identifier | HIGH — links tool calls to specific subagents |
| `agent_type` | Subagent type on failure | HIGH — identifies which agent types fail |
| `agent_transcript_path` | Path to subagent JSONL | MEDIUM — could cross-reference |
| `stop_hook_active` | Whether stop hook ran | LOW |

---

## 5. OTel Attribute Mapping Convention
**File**: `internal/tracer/CLAUDE.md`

- Domain-prefixed fields split at first underscore: `tool_name` → `tool.name`
- Flat fields unchanged: `cwd`, `error`, `is_interrupt`
- All JSON inputs truncated to 4096 chars for export

---

## 6. Key Takeaways for ccaudit

### Confirmed Patterns
- **MCP naming**: Always `mcp__<server>__<tool>` with double underscores — both implementations agree
- **Split logic**: Strip `mcp__` prefix, find next `__`, split into (server, tool)
- **Content block extraction**: `message.content[]` where `type === "tool_use"` — consistent across all tools

### Adopt
- **MCP split function**: Simple, well-tested — replicate in TypeScript
- **tool_use_id matching**: Link tool_use to tool_result by ID for complete invocation tracking
- **Graceful handling**: Return Option/null for non-MCP names, don't throw

### Not Relevant for v1
- **Hook-based capture**: ccaudit v1 is analysis-only from JSONL — hooks are for future MCP integration
- **OTel export**: Not part of ccaudit's scope
- **Real-time tracking**: ccaudit is post-hoc analysis

### Future Consideration (v1.1+)
- Hook schema knowledge useful if ccaudit adds `--live` MCP measurement
- `SubagentStop` events could help track agent lifecycle duration
- `agent_transcript_path` could enable cross-referencing subagent sessions

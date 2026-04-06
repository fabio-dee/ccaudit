# Code Study: ccboard — JSONL Parsing for Agents/MCP

## Executive Summary

**Language**: Rust (async/await with tokio)
**Purpose**: Dashboard for Claude Code session analytics — token usage, tool invocations, agent spawns, MCP calls, cost tracking
**Architecture**: Multi-crate monorepo with streaming JSONL parser, BM25 search, and web UI

---

## 1. How They Parse Agent Invocations from JSONL

### Fields and Detection Logic
**File**: `crates/ccboard-core/src/parsers/invocations.rs` (lines 80-123)

```rust
if let Some(ref content) = message.content {
    if let Some(content_array) = content.as_array() {
        for item in content_array {
            if let Some(obj) = item.as_object() {
                // Agent detection: name == "Task", extract subagent_type
                if obj.get("name").and_then(|v| v.as_str()) == Some("Task") {
                    if let Some(input) = obj.get("input").and_then(|v| v.as_object()) {
                        if let Some(agent_type) = input.get("subagent_type").and_then(|v| v.as_str()) {
                            *stats.agents.entry(agent_type.to_string()).or_insert(0) += 1;
                        }
                    }
                }
                // Skill detection: name == "Skill", extract skill name
                if obj.get("name").and_then(|v| v.as_str()) == Some("Skill") {
                    if let Some(input) = obj.get("input").and_then(|v| v.as_object()) {
                        if let Some(skill_name) = input.get("skill").and_then(|v| v.as_str()) {
                            *stats.skills.entry(skill_name.to_string()).or_insert(0) += 1;
                        }
                    }
                }
            }
        }
    }
}
```

**Detection criteria**:
- Block must have `"type": "tool_use"` in `message.content` array
- Agent: `name == "Task"` → extract `input.subagent_type`
- Skill: `name == "Skill"` → extract `input.skill`

### 5-Type Classification System
**File**: `crates/ccboard-core/src/analytics/plugin_usage.rs` (lines 21-33, 158-217)

```rust
pub enum PluginType {
    Skill,        // From .claude/skills/
    Command,      // From .claude/commands/
    Agent,        // Task tool invocations
    McpServer,    // mcp__server__tool format
    NativeTool,   // Built-in (Read, Write, Edit, Bash, etc.)
}
```

Classification priority:
1. `mcp__` prefix → McpServer
2. `name == "Task"` → Agent
3. Name matches skill list (case-insensitive) → Skill
4. Name matches command list → Command
5. Name in NATIVE_TOOLS list → NativeTool
6. Default → NativeTool

---

## 2. How They Parse MCP Usage from JSONL

### MCP Naming Pattern
**File**: `crates/ccboard-core/src/parsers/activity.rs` (lines 260-282)

```rust
name if name.starts_with("mcp__") => {
    // Format: mcp__<server>__<tool>
    let server = name
        .strip_prefix("mcp__")
        .and_then(|s| s.split("__").next())
        .unwrap_or("unknown")
        .to_string();
    // Also extracts url/uri from input for network tracking
    let url = call.input
        .get("url")
        .or_else(|| call.input.get("uri"))
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string();
}
```

**Confirmed**: `mcp__<server>__<tool>` — double underscore prefix, double underscore separator.

Server name extracted by: strip `mcp__` prefix, split on `__`, take first segment.

### MCP Data Structures
```rust
pub enum NetworkTool {
    WebFetch,
    WebSearch,
    McpCall { server: String },
}
```

MCP tools aggregated into `PluginUsage` records with invocation counts, session IDs, token attribution, cost calculations, first/last seen timestamps.

---

## 3. Data Structures — In-Memory Representation

### InvocationStats
**File**: `crates/ccboard-core/src/models/invocations.rs`

```rust
pub struct InvocationStats {
    pub agents: HashMap<String, usize>,           // subagent_type → count
    pub commands: HashMap<String, usize>,          // /command → count
    pub skills: HashMap<String, usize>,            // skill_name → count
    pub agent_token_stats: HashMap<String, u64>,   // subagent_type → tokens
    pub last_computed: DateTime<Utc>,
    pub sessions_analyzed: usize,
}
```

### SessionMetadata
**File**: `crates/ccboard-core/src/parsers/session_index.rs` (lines 404-484)

```rust
pub struct SessionMetadata {
    pub id: SessionId,
    pub file_path: PathBuf,
    pub project_path: ProjectId,
    pub first_timestamp: Option<DateTime<Utc>>,
    pub last_timestamp: Option<DateTime<Utc>>,
    pub message_count: u64,
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub models_used: Vec<String>,
    pub model_segments: Vec<(String, usize)>,     // Model switches within session
    pub first_user_message: Option<String>,
    pub has_subagents: bool,
    pub parent_session_id: Option<String>,
    pub branch: Option<String>,
    pub tool_usage: HashMap<String, usize>,        // tool_name → invocation_count
    pub tool_token_usage: HashMap<String, u64>,    // tool_name → token_count
    pub source_tool: SourceTool,                   // ClaudeCode, Cursor, Codex, OpenCode
    pub lines_added: u64,
    pub lines_removed: u64,
}
```

### PluginUsage
**File**: `crates/ccboard-core/src/analytics/plugin_usage.rs` (lines 59-80)

```rust
pub struct PluginUsage {
    pub name: String,
    pub plugin_type: PluginType,
    pub icon: String,
    pub total_invocations: usize,
    pub sessions_used: Vec<String>,
    pub total_cost: f64,
    pub avg_tokens_per_invocation: u64,
    pub first_seen: DateTime<Utc>,
    pub last_seen: DateTime<Utc>,
}
```

---

## 4. Aggregation Logic

### Per-Tool Token Distribution
**File**: `crates/ccboard-core/src/parsers/session_index.rs` (lines 438-520)

Tokens distributed proportionally across tools in the same message:
```rust
// Collect tool names in this message
let message_tools: Vec<String> = blocks.iter()
    .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
    .filter_map(|b| b.get("name").and_then(|n| n.as_str()).map(String::from))
    .collect();

// Distribute message tokens proportionally
if !message_tools.is_empty() {
    let tokens_per_tool = message_tokens / tool_count;
    let remainder = message_tokens % tool_count;
    for (i, tool_name) in message_tools.iter().enumerate() {
        let extra = if i == 0 { remainder } else { 0 };
        *tool_token_usage.entry(tool_name.clone()).or_default() += tokens_per_tool + extra;
    }
}
```

### Cross-Session Aggregation
**File**: `crates/ccboard-core/src/analytics/plugin_usage.rs` (lines 228-363)

```rust
pub fn aggregate_plugin_usage(
    sessions: &[Arc<SessionMetadata>],
    available_skills: &[String],
    available_commands: &[String],
) -> PluginAnalytics {
    // For each session → for each tool → classify + proportional cost
    let tool_cost = session_cost * (*call_count as f64 / total_calls as f64);
    // Also identifies dead code (defined but never used)
}
```

---

## 5. JSONL File Discovery

### Discovery Method
**File**: `crates/ccboard-core/src/parsers/session_index.rs` (lines 66-82)

- Uses `walkdir` crate (recursive directory walk)
- Filters by `.jsonl` extension
- Location: `~/.claude/projects/`
- Path encoding: `/Users/foo/myproject` → `-Users-foo-myproject`
- **Parallel scanning**: Bounded concurrency with `tokio::sync::Semaphore`

### Safety Limits
| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_LINE_SIZE` | 10 MB | Per-line OOM protection |
| `MAX_SCAN_LINES` | 10,000 | Circuit breaker per file |
| `PREVIEW_MAX_CHARS` | 200 | First user message truncation |
| `max_concurrent` | 8 | Parallel session scan limit |

### Cache Support
- Metadata cache in `~/.claude/cache/` using SQLite
- 90% speedup on startup if cache is fresh (mtime-based validation)

---

## 6. Key JSONL Field Mapping

| Field | Purpose | Type | Example |
|-------|---------|------|---------|
| `type` | Event type | String | "user", "assistant", "summary" |
| `sessionId` | Session identifier | String | "abc123-def456" |
| `message.content` | Message text or blocks | String or Array | `[{type:"tool_use",...}]` |
| `usage` | Token count | Object | `{inputTokens:100, outputTokens:50}` |
| `model` | Model used | String | "claude-opus-4-1-20250805" |
| `gitBranch` | Git state | String | "main" |

### Tool Invocation Detection Summary

| Type | Detection | Extract Field | Example |
|------|-----------|---------------|---------|
| Agent | `tool_use.name == "Task"` | `input.subagent_type` | "technical-writer" |
| Skill | `tool_use.name == "Skill"` | `input.skill` | "pdf-generator" |
| MCP | `name.starts_with("mcp__")` | Split on `__` | `mcp__gmail__authenticate` |
| Command | User message | `/^\/[a-z][a-z0-9-]*$/` | "/commit" |
| Native | Name in built-in list | Direct | "Read", "Write", "Bash" |

---

## 7. Key Takeaways for ccaudit

### Adopt
- **5-type classification** (Skill, Command, Agent, McpServer, NativeTool) — comprehensive taxonomy
- **Proportional token distribution** across tools in same message — better token accounting
- **`first_seen` / `last_seen` timestamps** per tool — essential for ghost detection (lastUsed date)
- **`has_subagents` + `parent_session_id`** — track subagent relationships
- **File size protection** (MAX_LINE_SIZE, MAX_SCAN_LINES) — prevent OOM on corrupt files
- **Dead code detection** (defined but never used plugins) — exactly what ccaudit does

### Avoid
- **Rust-specific patterns** (ownership, async traits) — we're in TypeScript
- **SQLite cache** — overkill for a CLI tool that runs once; we can use in-memory only
- **Web UI architecture** — ccaudit is terminal-only v1

### Novel patterns
- **Model switching tracking** (`model_segments`) — could detect model-specific tool usage
- **Code metrics extraction** (lines added/removed from Edit/Write inputs)
- **Source tool detection** (ClaudeCode vs Cursor vs Codex vs OpenCode) — multi-client awareness
- **Worktree path normalization** — handles git worktree paths correctly

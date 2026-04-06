# Code Study: Agent-Registry — Archive Algorithm

## Executive Summary

**Language**: JavaScript (CommonJS)
**Runtime**: Bun (ships with Claude Code)
**Purpose**: Lazy-loading system for Claude Code agents — reduces context window token usage by 70-90% by maintaining a lightweight JSON index and loading agents on-demand through BM25 search
**Architecture**: Claude Code skill (~1,640 LOC) with CLI tools, hook system, and BM25 search engine

---

## 1. Archive Algorithm

### Overview
The archive process is **non-destructive by default**. Agents are "migrated" from `~/.claude/agents/` into `~/.claude/skills/agent-registry/agents/`.

### File Operations
**File**: `bin/init.js` (lines 240-290)

```javascript
function migrateAgents(agents, targetDir, mode) {
  for (const agent of agents) {
    if (fs.existsSync(target)) {
      // Skip if already exists — no overwrite
      continue;
    }
    if (mode === "move") {
      fs.renameSync(source, target);
      // Cross-device fallback: copy + delete
    } else {
      fs.copyFileSync(source, target);  // Default: non-destructive copy
    }
  }
}
```

**Default mode**: `--copy` (leaves originals intact)
**Destructive mode**: `--move` (explicit opt-in, with cross-device fallback via copy+unlink)
**Conflict handling**: Silent skip if agent already exists in registry

### Archive Directory Structure
```
~/.claude/skills/agent-registry/
├── agents/                        # Migrated agent files
│   ├── frontend/                  # Preserves subdirectory structure
│   │   └── react-expert.md
│   └── backend/
│       └── django-expert.md
├── references/
│   └── registry.json              # Index manifest
├── lib/                           # Shared modules
├── bin/                           # CLI tools
└── hooks/                         # Event hooks
```

### Metadata Extracted During Archival
**File**: `bin/init.js` (lines 292-338), `lib/parse.js`

```javascript
registry.agents.push({
  name: agent.name,                    // Filename without .md
  path: relPath,                       // Relative path in agents/
  summary: agent.summary,             // First paragraph, max 200 chars
  keywords: agent.keywords,           // Tech terms + header words, max 20
  token_estimate: Math.floor(content.length / 4),  // ~1 token per 4 bytes
  content_hash: contentHash(content),  // 8-char MD5 for change detection
});
```

---

## 2. Index/Manifest

### Format: JSON (`references/registry.json`)

```json
{
  "version": 1,
  "generated_at": "2024-04-03T21:52:00.000Z",
  "skill_dir": "/Users/user/.claude/skills/agent-registry",
  "agents": [
    {
      "name": "react-expert",
      "path": "frontend/react-expert.md",
      "summary": "React specialist focused on modern component architecture...",
      "keywords": ["react", "javascript", "frontend", "hooks"],
      "token_estimate": 1850,
      "content_hash": "a3f2b1c4"
    }
  ],
  "stats": {
    "total_agents": 150,
    "total_tokens": 17500,
    "tokens_saved_vs_preload": 17500
  }
}
```

### Index Size Metrics (from README)
| Agent Count | Index Size | Savings |
|-------------|-----------|---------|
| 50 agents | ~2k tokens | 60-70% |
| 150 agents | ~3-4k tokens | 80% |
| 300 agents | ~6-8k tokens | 85-90% |

Per-agent overhead: ~20-25 tokens/agent in index vs ~117 tokens/agent if loaded upfront.

---

## 3. Restore Logic

**No traditional restore**. Agents remain in registry permanently. Loading is on-demand.

### Agent Loading (Lazy Restore)
**File**: `bin/get.js` (lines 30-48)

```javascript
function loadAgentContent(agent) {
  const resolved = resolveRegistryAgentPath(agent.path);
  if (!resolved.ok) return null;
  if (!fs.existsSync(resolved.path)) return null;
  return fs.readFileSync(resolved.path, "utf8");
}
```

### Path Security
**File**: `lib/registry.js` (lines 30-56)

```javascript
function resolveRegistryAgentPath(agentPath) {
  // Resolve relative or absolute paths
  // SECURITY: Prevent path traversal
  if (!isPathInsideDir(agentsDir, resolved)) {
    return { ok: false, error: `Refusing to load agent outside '${agentsDir}'` };
  }
  return { ok: true, path: resolved };
}
```

Rejects path traversal (`../../etc/passwd`), validates all paths within `agents/` directory.

---

## 4. Token Reduction Measurement

### How 70-90% is Claimed

**Before** (eager loading): ~117 tokens/agent × agent count
**After** (lazy loading): Registry index (~2-4k tokens) + only loaded agents (~200-400 tokens each)

```
140 agents: 16.4k tokens → 2.7k tokens = 83% reduction
```

### Token Estimation Code
**File**: `lib/parse.js` (line 121)

```javascript
token_estimate: Math.floor(content.length / 4)
```

**Limitations**:
- Approximate (1 token ≈ 4 bytes)
- No model-specific tokenization
- Doesn't account for markdown/YAML syntax efficiency

### What's NOT Measured
- Actual context window usage before/after in real sessions
- Real token consumption per agent (only estimates)
- Per-session token savings (no telemetry for this)

`tokens_saved_vs_preload` is a **theoretical** number, not measured in practice.

---

## 5. Discovery Logic

### Agent Scanning
**File**: `bin/init.js` (lines 70-93)

```javascript
function findAgentLocations() {
  // Scans two directories:
  // 1. ~/.claude/agents/ (global)
  // 2. .claude/agents/ (project-level, if different)
}

function walkDir(dir) {
  // Recursive walk, collects all .md files
}
```

**What qualifies as "archivable"**:
- File has `.md` extension
- File is parseable (valid UTF-8, readable)
- No other constraints (no minimum size, no metadata required)

**No usage analysis** — discovery is purely file-based, not frequency-based. User manually selects which agents to migrate via interactive UI.

### Interactive Selection
**File**: `bin/init.js` (lines 140-237)

Uses `@clack/prompts` for checkbox UI with:
- Category grouping (subdirectories)
- Token indicators (green <1k, yellow 1-3k, red >3k)
- Multi-select with All/None toggles
- Fallback to readline-based input if `@clack/prompts` unavailable

---

## 6. Safety Mechanisms

### No Explicit Backup System
Safety relies on:
1. **Non-destructive default**: Copy mode is default, `--move` is explicit opt-in
2. **Content hash tracking**: MD5 hash for change detection (but no auto-update)
3. **Path security**: Traversal protection on all path operations

### No Rollback
- No transaction log or undo mechanism
- To "undo": manually delete from `agents/` + rebuild index
- Partial undo not supported

### Error Accumulation (Non-Fatal)
```javascript
const { migrated, errors } = migrateAgents(selected, getAgentsDir(), options.mode);
// Errors don't stop migration — accumulated and reported at end
```

---

## 7. Search Algorithm (BM25 Hybrid)

### Implementation
**File**: `lib/search.js` (lines 14-182)

Custom BM25 from scratch (no external library):
- **k1 = 1.5**: Term frequency saturation
- **b = 0.75**: Length normalization

Combined scoring: **60% BM25 + 40% keyword matching**
- Name match: 3x weight
- Keyword match: 2x weight
- Summary match: 1x weight
- Partial substring: +0.5

### Automatic Discovery via Hook
**File**: `hooks/user_prompt_search.js` (83 lines)

- Runs on every `UserPromptSubmit` hook event
- Skips slash commands and short prompts (<3 words)
- BM25 search (top 3, score ≥ 0.5)
- Injects matching agents into `additionalContext`
- ~100ms execution, silent failure

---

## 8. Architecture Overview

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Migration wizard | `bin/init.js` | 453 | Scan, prompt, copy/move, build index |
| BM25 search | `lib/search.js` | 198 | Hybrid scoring algorithm |
| Agent loader | `bin/get.js` | 144 | Path-secured content loading |
| Metadata parser | `lib/parse.js` | 135 | Summary, keywords, tokens, hash |
| Index rebuilder | `bin/rebuild.js` | 115 | Regenerate registry.json |
| List command | `bin/list.js` | 118 | Table/detailed/simple/JSON output |
| Auto-discovery | `hooks/user_prompt_search.js` | 83 | Hook-based agent injection |
| Path utilities | `lib/registry.js` | 97 | Security + I/O |
| Telemetry | `lib/telemetry.js` | 80 | Anonymous tracking |
| CLI dispatcher | `bin/cli.js` | 50 | Command routing |

**Total**: ~1,640 lines core logic, 101 tests across 5 files.

---

## 9. Key Takeaways for ccaudit

### Adopt
- **Token estimation** (`content.length / 4`) — same approximation for ghost cost reporting
- **Content hash** for change detection — useful for checkpoint validation
- **Relative path storage** in manifest for portability
- **Non-destructive default** with explicit destructive opt-in — matches our `--dangerously-bust-ghosts` philosophy
- **Path traversal protection** — essential for any file mutation operations

### Avoid
- **No rollback** — ccaudit MUST have full rollback (archive, not delete)
- **No usage analysis in discovery** — ccaudit's core value is JSONL cross-reference
- **BM25 search** — irrelevant to our use case (we're not searching, we're auditing)
- **Hook-based injection** — ccaudit is a CLI tool, not a persistent skill
- **Theoretical token measurement** — we need to measure/estimate actual tokens, not just claim savings

### Patterns to improve on
- **Archive with metadata**: Agent-Registry stores minimal metadata (name, summary, keywords). ccaudit should store the full audit context (lastUsed date, invocation count, session references)
- **Atomic operations**: Agent-Registry has no transaction system. ccaudit needs checkpoint-based atomicity for the bust-ghosts flow
- **Real token measurement**: Agent-Registry claims 70-90% but doesn't measure actual impact. ccaudit should estimate actual context overhead per ghost item

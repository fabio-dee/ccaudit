# Code Study: claude-code-transcripts — Clean Parser Reference

## Executive Summary

**Language**: Python 3.10+
**Purpose**: Parse Claude Code JSONL session logs and convert to readable HTML transcripts
**Author**: Simon Willison

---

## 1. Parser Implementation

### Core Parser
**File**: `src/claude_code_transcripts/__init__.py` (lines 467-499)

**Approach**: Line-by-line streaming — memory-efficient, not buffered.

```python
def load_jsonl(path: Path) -> list[dict]:
    """Load a JSONL file, skipping invalid lines."""
    entries = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries
```

Also supports full JSON files:
```python
def load_json_or_jsonl(path: Path) -> list[dict]:
    """Load either JSON or JSONL file."""
    try:
        with open(path) as f:
            data = json.load(f)
            if isinstance(data, list):
                return data
            return [data]
    except json.JSONDecodeError:
        return load_jsonl(path)
```

Key pattern: **Try JSON first, fall back to JSONL** — handles both formats transparently.

---

## 2. Error Handling Strategy

### Skip-and-Continue Resilience
- `json.JSONDecodeError` caught per line — continues to next line
- Two-pass extraction with intelligent fallbacks (explicit summaries first, then user messages)
- Batch operations collect errors with context instead of aborting
- No dedicated logging — uses exception handling and error collection lists

### Batch Error Collection
When processing multiple sessions/projects, errors are collected with context:
```python
errors = []
for project in projects:
    try:
        sessions = process_project(project)
    except Exception as e:
        errors.append({"project": project.name, "error": str(e)})
        continue
```

---

## 3. Data Extraction Patterns

### Dual-Format Content Handling
Messages have content that can be either string or array:
```python
def get_content_text(message: dict) -> str:
    content = message.get("message", {}).get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block.get("text", "") for block in content
            if block.get("type") == "text"
        )
    return ""
```

### Tool Use Extraction
```python
def extract_tool_uses(message: dict) -> list[dict]:
    content = message.get("message", {}).get("content", [])
    if not isinstance(content, list):
        return []
    return [
        block for block in content
        if block.get("type") == "tool_use"
    ]
```

### Summary Extraction with Prioritization
Multi-pass approach:
1. Check for explicit `summary` field
2. Extract from first user message content
3. Fall back to session metadata
4. Truncate to reasonable display length

---

## 4. File Discovery

### Glob Pattern
```python
sessions = sorted(project_dir.glob("**/*.jsonl"))
```
Recursive, case-sensitive `.jsonl` extension.

### Filtering
- Agent/subagent files excluded by default (files in `subagents/` subdirectory)
- Warmup/empty sessions skipped during discovery (checked by file size or entry count)

### Metadata Collection
For each discovered session:
- Path (relative to project)
- Summary (extracted from content)
- Modification time (`path.stat().st_mtime`)
- File size

### Sorting
- Within project: by modification time (newest first)
- Cross-project: by most recent session timestamp

---

## 5. Session Grouping & Organization

### Hierarchical Structure
```
projects/
├── -Users-foo-project1/
│   ├── session-abc123.jsonl
│   └── session-def456.jsonl
├── -Users-foo-project2/
│   └── session-ghi789.jsonl
```

Project names decoded from path encoding:
- Leading `-` represents `/`
- `--` represents `/_` (underscore in path)

### Entry Types Handled
From JSONL records:
- `type: "user"` — user messages
- `type: "assistant"` — assistant responses with tool_use blocks
- `type: "system"` — system messages, session metadata
- `type: "progress"` — progress updates (typically filtered)

---

## 6. Unique Patterns Worth Adopting

### 1. Dual-format normalization
Single entry point (`load_json_or_jsonl`) handling both JSON and JSONL transparently. Try JSON parse first, fall back to line-by-line JSONL.

### 2. Multi-pass extraction
Primary extraction + fallback for intelligent defaults (summary from explicit field → first message → metadata).

### 3. Metadata-driven filtering
Filter at discovery time (skip subagent files, empty sessions) rather than loading everything and post-filtering.

### 4. Pathlib throughout
Cross-platform path handling with chainable operations — Python-specific but the principle (use path abstractions, not string manipulation) applies to Node.js `path` module too.

### 5. Explicit field mapping
Clear schema definition during transformation — not wholesale copying of unknown fields.

### 6. Content type polymorphism
`message.content` can be string OR array — handling both transparently is essential. Our valibot schemas must account for this.

---

## 7. Relevance to ccaudit

### Low but useful
This is primarily an HTML transcript generator, not an analytics tool. The JSONL parsing is straightforward and correct but doesn't do the kind of aggregation/analysis ccaudit needs.

### Patterns to replicate
- **Skip-and-continue** for malformed lines (matches our valibot safeParse strategy)
- **Dual content format** handling (string | array)
- **Subagent file filtering** (skip `subagents/` subdirectory by default, or handle separately)
- **Project path decoding** logic (though we should use `cwd` field as authoritative)

### Patterns NOT relevant
- HTML generation
- Python-specific idioms (pathlib, list comprehensions)
- Summary extraction for display (we want usage signals, not content summaries)

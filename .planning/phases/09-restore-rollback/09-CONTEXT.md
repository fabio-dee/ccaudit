# Phase 9: Restore & Rollback - Context

**Gathered:** 2026-04-05
**Status:** Ready for planning

<domain>
## Phase Boundary

`ccaudit restore` fully reverses any remediation performed by `--dangerously-bust-ghosts` — moving archived agents/skills back to their original paths, renaming disabled MCP keys back in `~/.claude.json` and `.mcp.json`, and stripping `ccaudit-stale`/`ccaudit-flagged` frontmatter from memory files. Phase 9 reads the JSONL manifests written by Phase 8, handles crash-detected partial busts, and supports per-item restore by name. This phase owns rollback only. It does NOT own bust execution (Phase 8) or community contribution (Phase 10).

</domain>

<decisions>
## Implementation Decisions

### Command structure

- **D-01:** `ccaudit restore` is a new gunshi subcommand registered alongside `ghost`, `mcp`, `inventory`, `trend` in `apps/ccaudit/src/cli/index.ts`. Three invocations (all on the same subcommand with gunshi args):
  - `ccaudit restore` — full restore from most recent manifest
  - `ccaudit restore <name>` — restore single archived item by name (positional arg)
  - `ccaudit restore --list` — list all archived items across all busts

- **D-02:** `<name>` is the **base filename without extension** — e.g., `ccaudit restore code-reviewer` matches `code-reviewer.md`. Matched against `archive_path` basename (without extension) in manifest ops. Case-sensitive match (filesystem on macOS is case-insensitive but match should be explicit). Only `archive` op types are matched by name; `disable` and `flag` ops are not addressable by `restore <name>`.

### Manifest discovery

- **D-03:** `ccaudit restore` (full restore, no args) selects the **newest manifest by mtime** from `~/.claude/ccaudit/manifests/bust-*.jsonl`. If no manifests exist, exit 0 with message: `No bust history found. Run ccaudit --dangerously-bust-ghosts first.`

- **D-04:** `ccaudit restore --list` reads **all manifest files** from `~/.claude/ccaudit/manifests/`, sorted newest-first by mtime. Output is grouped by bust (one section per manifest file) with the bust timestamp, clean/partial status, and item count in the header. Per-item rows show: category, name, archive_path (for agents/skills) or config_path + key (for MCP). Memory flag/refresh ops are included with a `(frontmatter)` annotation. Honors Phase 6 `--json`, `--quiet`, and `--no-color` flags.

- **D-05:** `ccaudit restore <name>` (single-item restore) searches **all manifests**, newest-first, and restores from the **most recent bust** that contains an archive op for that name. If no match found across any manifest: exit 0 with `No archived item named '<name>' found.`

### Partial bust handling

- **D-06:** **Warn + auto-proceed (no prompt).** When the selected manifest has a header but no footer (crash-detected), print:
  ```
  ⚠️  Partial bust detected — bust-<ISO>.jsonl has no completion record.
      Restoring operations that were recorded.
  ```
  Then proceed with best-effort restore of all ops that appear in the manifest. This matches Phase 8 D-12 wording ("best-effort restore"). No y/N gate — a crashed bust is already a broken state and auto-recovery is the right default.

- **D-07:** If the manifest has no header at all (corrupt), refuse with exit 1: `Manifest is corrupt (no header record). Cannot restore from bust-<ISO>.jsonl.`

### Restore operations per op type

- **D-08:** **Archive ops (agents + skills):** Move `archive_path → source_path`. Create parent directories if needed (`mkdir recursive`). Continue-on-error: if a move fails (ENOENT if file was manually deleted, EACCES, etc.), write a summary line `✗ <name> — <error>` and continue. Run the running-process gate BEFORE any ops begin (same `detectClaudeProcesses` from Phase 8 processes.ts — protects ~/.claude.json from concurrent writes; also gates file moves for consistency).

- **D-09:** **Disable ops (MCP servers):** Reverse the key-rename: read the config file (`config_path`), find the entry under `new_key`, rename it back to `original_key`. Transactional (fail-fast, all-or-nothing per config file) using `atomicWriteJson` from Phase 8. If `new_key` is not found (user manually re-enabled), warn and skip that op (do not fail). If `original_key` already exists in the config (name collision), warn and skip rather than overwrite. Phase 8's `original_value` field is NOT used for restore — the key-rename is reversed in-place, preserving any edits the user made to the config value between bust and restore.

- **D-10:** **Flag ops (memory files):** Strip `ccaudit-stale` and `ccaudit-flagged` keys from the frontmatter. Use the same hand-rolled frontmatter patcher from Phase 8 (`patchFrontmatter`), or implement a targeted key-removal function. Do NOT restore full original content — only remove the two ccaudit-specific keys. If the file no longer exists, warn and skip. Continue-on-error.

- **D-11:** **Refresh ops (memory files):** Restore the previous `ccaudit-flagged` timestamp: set `ccaudit-flagged: <previous_flagged_at>` in the frontmatter (replacing the current refreshed value). The `ccaudit-stale: true` key is left in place (it was there before the bust; the bust only refreshed the timestamp). Continue-on-error.

- **D-12:** **Skipped ops:** No action — these items were not mutated during bust, nothing to restore.

### Tamper detection

- **D-13:** For `archive` ops, compare the SHA256 of the current file at `archive_path` against `content_sha256` from the manifest. On mismatch (file was edited in `_archived/` after bust): print `⚠️  <name> was modified after archiving — restoring anyway` and proceed with the move. The user's edited version is restored to `source_path`. Continue-on-error policy; mismatch is a warning, not a failure.

### Running-process gate

- **D-14:** Before executing any restore operations, run `detectClaudeProcesses()` from Phase 8 `processes.ts`. Same exit-3 policy: if Claude Code is running (including self-invocation detection), refuse with the same message format as bust. Rationale: restore writes to `~/.claude.json` (re-enabling MCP servers), which risks concurrent-write corruption of OAuth tokens. Full restore and partial restore both gate. `ccaudit restore --list` is read-only and skips the gate.

### Failure policy

- **D-15:** **Hybrid failure policy (mirrors Phase 8 D-14):**
  - **Independent fs ops** (agent/skill moves, memory file frontmatter patches): continue-on-error. Summary at end reports `<N successful, M failed>` per category.
  - **`~/.claude.json` + `.mcp.json` mutations** (MCP key-rename reversal): fail-fast per config file. All renames for a given config file succeed together or none are applied. Distinct from per-item fs failures.
  - **Exit codes**: 0 = all ops restored successfully; 1 = one or more ops failed; 3 = running-process preflight blocked restore.

### Output format

- **D-16:** Default rendered output mirrors the bust output style (Phase 5/6 branding):
  ```
  👻 Restore — 2026-04-05T18-30-00Z
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓ Restored 128 agents
  ✓ Restored  82 skills
  ✓ Re-enabled  4 MCP servers
  ✓ Stripped ccaudit flags from 6 memory files
  
  All operations completed. Ghost inventory is back to pre-bust state.
  ```
  `--verbose` appends per-item lines. `--quiet` suppresses decorative output. `--json` emits a structured envelope. `--no-color` / `NO_COLOR` honored. `--ci` = quiet + JSON + exit code. All Phase 6 output modes apply.

### Claude's Discretion

- Exact module layout: recommend `packages/internal/src/remediation/restore.ts` for the restore orchestrator (parallel to `bust.ts`) + injectable deps for testing
- JSON envelope schema for `--json` restore output (follow Phase 6 `buildJsonEnvelope` pattern)
- CSV schema for `--restore --csv` (recommend: `action,category,name,scope,source_path,archive_path,status,error`)
- `--since` flag: NOT applicable to restore (restore reads manifest, not JSONL sessions)
- Exact wording of per-item verbose lines and summary footer
- Whether `restore <name>` should also search across `disable` ops (MCP server names) — recommend yes: `ccaudit restore playwright` should find a disabled MCP server and re-enable it, not just agents/skills

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — RMED-11, RMED-12, RMED-13 (Phase 9 scope)
- `.planning/ROADMAP.md` — Phase 9 section, success criteria

### Prior CONTEXT (contracts Phase 9 consumes)
- `.planning/phases/08-remediation-core/08-CONTEXT.md` — **primary upstream contract**:
  - D-01: Two-gate checkpoint verification (Phase 9 does NOT need to re-verify checkpoint — restore reads manifest directly)
  - D-05, D-06: Archive collision naming (ISO timestamp suffix on `_archived/` filenames — restore must handle these)
  - D-07: Refresh op schema (`previous_flagged_at` field — Phase 9 restores this)
  - D-09, D-10, D-11, D-12: Manifest format (header/footer/op schemas, crash detection rule)
  - D-13: Execution order (bust went agents → skills → MCP → memory; restore reverses: memory → MCP → skills → agents, or parallel — planner's call)
  - D-14: Hybrid failure policy (Phase 9 mirrors this)
  - D-18: `atomicWriteJson` shared helper (Phase 9 reuses for MCP config mutation)
- `.planning/phases/07-dry-run-checkpoint/07-CONTEXT.md` — checkpoint schema (not needed for restore directly)
- `.planning/phases/06-output-control-polish/06-CONTEXT.md` — output modes Phase 9 must honor

### Handoff doc
- `docs/ccaudit-handoff-v6.md` lines 165–221 — restore UX mockups and examples (`ccaudit restore code-reviewer` → moves back to original path; memory restore strips frontmatter keys)

### Existing code (integration points)
- `packages/internal/src/remediation/manifest.ts` — `readManifest()`, `ManifestOp`, `ArchiveOp`, `DisableOp`, `FlagOp`, `RefreshOp`, `SkippedOp`, `ReadManifestResult` — Phase 9 reads these directly. `resolveManifestPath()` provides the path pattern for manifest discovery.
- `packages/internal/src/remediation/processes.ts` — `detectClaudeProcesses()`, `defaultProcessDeps` — D-14 running-process gate reused verbatim.
- `packages/internal/src/remediation/atomic-write.ts` — `atomicWriteJson()` — D-15 MCP config mutation.
- `packages/internal/src/remediation/frontmatter.ts` — `patchFrontmatter()` — D-10 memory file key-stripping (or implement a targeted removal on top of the existing patcher).
- `packages/internal/src/remediation/index.ts` — barrel export; Phase 9 adds `restore.ts` exports here.
- `apps/ccaudit/src/cli/index.ts` — add `restore: restoreCommand` to `subCommands`.
- `apps/ccaudit/src/cli/_shared-args.ts` + `_output-mode.ts` — Phase 9 restore command reuses `outputArgs` and `resolveOutputMode`.
- `apps/ccaudit/src/cli/commands/ghost.ts` — reference for command structure pattern.
- `packages/terminal/src/index.ts` — `renderHeader`, `initColor`, `colorize` — Phase 9 rendering.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`readManifest(filePath)`** — already implemented in `manifest.ts`. Returns `{ header, ops, footer, truncated }`. Phase 9 reads this and iterates `ops` by type.
- **`resolveManifestPath(now)`** — provides the path pattern. For manifest discovery, Phase 9 needs a `glob` of `~/.claude/ccaudit/manifests/bust-*.jsonl` and stat-sort by mtime.
- **`detectClaudeProcesses()` + `defaultProcessDeps`** — drop-in for D-14 running-process gate.
- **`atomicWriteJson(path, value)`** — drop-in for D-15 MCP config mutations.
- **`patchFrontmatter(content, keys)`** — Phase 8 uses this to inject ccaudit keys; Phase 9 needs to remove them. The existing API may need a `removeFrontmatterKeys(content, keys)` sibling function, or extend the existing patcher.
- **`outputArgs` + `resolveOutputMode` + `buildJsonEnvelope`** — Phase 6 infrastructure; restore gets all output modes "for free" by reusing these.
- **In-source test pattern** (`if (import.meta.vitest)`) — follow Phase 8 conventions.
- **`StatFn` dependency injection** — precedent from checkpoint.ts; Phase 9's restore orchestrator should use injectable deps (manifest reader, fs ops, process detector) for testability.

### Established Patterns
- **gunshi subcommand registration** — `export const restoreCommand = define(...)` in `commands/restore.ts`, imported in `index.ts`.
- **Continue-on-error for fs ops** — established in Phase 8 bust.ts for agent/skill archive; same pattern for Phase 9 unarchive.
- **Fail-fast transactional for `~/.claude.json`** — established in Phase 8 `disableMcpTransactional`; Phase 9 `reEnableMcpTransactional` mirrors it.
- **`ISO.replace(/:/g, '-')` for path-safe timestamps** — established in collisions.ts; relevant for matching collision-renamed archive filenames.
- **subprocess integration test** — `apps/ccaudit/src/__tests__/bust-command.test.ts` is the model for `restore-command.test.ts`.

### Integration Points
- **`packages/internal/src/remediation/restore.ts`** (new) — restore orchestrator: discover manifest → detect process → execute ops → summarize
- **`packages/internal/src/remediation/index.ts`** — add `restore.ts` exports
- **`apps/ccaudit/src/cli/commands/restore.ts`** (new) — CLI command handler (single/full/list routing)
- **`apps/ccaudit/src/cli/index.ts`** — add `restore: restoreCommand` to subCommands map
- **`apps/ccaudit/src/__tests__/restore-command.test.ts`** (new) — subprocess integration tests

</code_context>

<specifics>
## Specific Ideas

- **`--list` format confirmed by user** (chosen from preview):
  ```
  Archived items — 2 busts
  
  ● 2026-04-05T18-30-00Z  (clean bust, 210 items)
    agent   code-reviewer          ~/.claude/agents/_archived/code-reviewer.md
    skill   gsd-execute-phase      ~/.claude/skills/_archived/gsd-execute-phase.md
    mcp     playwright             ~/.claude.json (key: ccaudit-disabled:playwright)
    ...
  
  ● 2026-04-01T12-00-00Z  (clean bust, 198 items)
    agent   old-reviewer           ~/.claude/agents/_archived/old-reviewer.md
    ...
  ```
  "clean bust" vs "partial bust" in the section header is D-06/D-07's crash detection surfaced to `--list`.

- **Restore order**: Phase 8 D-13 executed archive → disable → flag. Phase 9 should reverse: strip flags → re-enable MCP → unarchive. This ensures that if any step fails, the user is not left with MCP re-enabled but agents still in `_archived/` (a less confusing failure state than the reverse).

- **`ccaudit restore <name>` should also match MCP server names** (Claude's discretion note in D-02). `ccaudit restore playwright` should find a `disable` op where `original_key === 'playwright'` and re-enable it. This is more useful than restricting `<name>` to agents/skills only.

- **No confirmation ceremony on restore** — restore is a recovery action, not a destructive one. No y/N prompt, no typed-phrase ceremony. The running-process gate (D-14) is the only preflight.

</specifics>

<deferred>
## Deferred Ideas

- **`ccaudit restore --from bust-2026-04-01` flag** — restore from a specific historical bust (not just most recent). Phase 8 D-10 preserves all manifests for this; the flag is a Phase 9+ enhancement. Add to backlog.
- **Interactive item selection** — `ccaudit restore --interactive` TUI to pick which items to restore. Out of scope for v1.2.
- **`restore --dry-run`** — preview what restore would do without touching files. Useful but not in RMED-11/12/13. Backlog.
- **Restore verification report** — compare restored state against pre-bust snapshot. Out of scope.

</deferred>

---

*Phase: 09-restore-rollback*
*Context gathered: 2026-04-05*

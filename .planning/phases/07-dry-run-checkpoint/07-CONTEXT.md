# Phase 7: Dry-Run & Checkpoint - Context

**Gathered:** 2026-04-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Users can run `ccaudit --dry-run` to preview exactly what `--dangerously-bust-ghosts` would change — which agents/skills would be archived, which MCP servers would be disabled, which memory files would be flagged, and how many tokens that would reclaim — without touching the filesystem. On successful preview, ccaudit writes a hash-based checkpoint to `~/.claude/ccaudit/.last-dry-run` that Phase 8 will use as a safety gate: bust is blocked unless a checkpoint exists whose `ghost_hash` matches the current archive-eligible inventory. This phase ships the dry-run code path, the change-plan data model, the checkpoint writer, and the grouped-by-action rendering layer. It does NOT ship any destructive operations — Phase 8 owns remediation; Phase 7 owns the preview + handshake.

</domain>

<decisions>
## Implementation Decisions

### --dry-run flag mechanics
- **D-01:** `--dry-run` is a boolean flag on the default `ghostCommand` (`apps/ccaudit/src/cli/commands/ghost.ts`). `ccaudit --dry-run` routes through the existing ghost command handler. No dedicated `dry-run` subcommand — single code path, zero new gunshi registration. This matches handoff §84–88 and ROADMAP Phase 7 wording verbatim.
- **D-02:** `--dry-run` honors every Phase 6 output mode: `--json`, `--csv`, `--quiet`, `--ci`, `--no-color`, `--verbose`. All flags share `outputArgs` from `apps/ccaudit/src/cli/_shared-args.ts` and the precedence chain in `_output-mode.ts`. Dry-run does NOT introduce any new output flags.
- **D-03:** Exit code on successful dry-run is **always 0** when both scan and checkpoint write succeed — even when the change plan is empty. Non-zero exit codes only for genuine errors (scan failure, checkpoint write failure, invalid `--since`). This contrasts intentionally with the non-dry-run ghost command (Phase 6 D-01: exit 1 when ghosts found) so users can chain: `ccaudit --dry-run && ccaudit --dangerously-bust-ghosts`.
- **D-04:** A zero-ghost dry-run **still writes the checkpoint**. The checkpoint reflects the scan completing successfully, not the presence of items. This simplifies Phase 8's gate to a single rule ("checkpoint exists AND hash matches") with no special-case for empty inventories; Phase 8 will no-op cleanly when there's nothing to bust.
- **D-05:** When `--dry-run` is active, the default rendered output of the ghost command is replaced with the change-plan rendering (see D-06). Output-mode branches (`--json`, `--csv`, `--quiet`) emit the change-plan data model instead of the inventory data model. The footer CTA from Phase 5 D-09 (which currently says "Dry-run coming in v1.1") is replaced with a checkpoint confirmation line when `--dry-run` is active: `Checkpoint: ~/.claude/ccaudit/.last-dry-run (hash: sha256:abc123..., written Xs ago)`.

### Change-plan layout & scope
- **D-06:** Rendered output is **grouped by action verb**, mirroring handoff §127–143 remediation UX. The `@ccaudit/terminal` package gains a `renderChangePlan(plan)` function that produces:
  ```
  👻 Dry-Run — Last 7 days
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Will ARCHIVE (reversible via `ccaudit restore <name>`):
    128 agents  → ~/.claude/agents/_archived/
     82 skills  → ~/.claude/skills/_archived/

  Will DISABLE in ~/.claude.json (key-rename, JSON-valid):
      4 MCP servers  (moved to `ccaudit-disabled:<name>` key)

  Will FLAG in memory files (ccaudit-stale: true frontmatter, still load):
      6 stale files

  Estimated savings: ~94k tokens/session (definite ghosts only)

  Checkpoint: ~/.claude/ccaudit/.last-dry-run
  Next: ccaudit --dangerously-bust-ghosts
  ```
  Header/divider reuses Phase 5 `renderHeader()` with emoji `👻` and title `Dry-Run`. Grouped format keeps the output screenshot-friendly and viral-aligned.
- **D-07:** The change plan includes **only items that would actually change**:
  - **Archive tier** (definite-ghost agents + definite-ghost skills) — will be moved to `_archived/` in Phase 8
  - **Disable tier** (definite-ghost MCP servers — both global and project-scoped) — will be key-renamed in Phase 8
  - **Flag tier** (stale memory files, tier !== used from `scanMemoryFiles`) — will receive frontmatter in Phase 8
  `likely-ghost` items (monitor recommendation per Phase 5 D-12) are **excluded** from the change plan entirely because Phase 8 does not touch them. They remain visible in `ccaudit ghost` (non-dry-run) but not in the dry-run action list.
- **D-08:** Estimated savings is a **new computation** distinct from `calculateTotalOverhead()`. Savings = sum of `tokenEstimate.tokens` for items in the Archive + Disable tiers only (`category ∈ {agent, skill, mcp-server}` AND `tier === 'definite-ghost'`). Memory files are **excluded from savings** because they are flagged-not-moved — they still load, so no tokens are reclaimed. The savings label always reads `"~Xk tokens (definite ghosts only)"` to disambiguate from `totalOverhead`.
- **D-09:** `--verbose` **appends a per-item listing** after the grouped summary. Each affected item renders as one line: `  • <action> <category> <name> (<scope>) — ~<tokens> tokens, last used <human-relative>, path: <path>`. The listing groups by action verb in the same order as the summary (Archive → Disable → Flag). Verbose scan diagnostics continue to go to stderr per Phase 6 D-13.

### Hash input scope (Phase 8 contract)
- **D-10:** The `ghost_hash` is computed over **archive-eligible items only** — the exact set that Phase 8 will mutate. Usage tiers that do not produce actions (likely-ghost → monitor, used → keep) do NOT contribute to the hash. This matches ROADMAP wording "agent file paths + mtimes + MCP configs" and means the hash changes if and only if the set of things that would be busted changes.
- **D-11:** Canonical record shape per eligible item:
  - **Agent / Skill** (`tier === 'definite-ghost'`): `{ category, scope, projectPath, path, mtimeMs }`
  - **MCP server** (`tier === 'definite-ghost'` OR `tier === 'likely-ghost'` — **see D-11a**): `{ category: 'mcp-server', scope, projectPath, serverName, sourcePath, configMtimeMs }`
  - **Memory file** (any stale tier — tier !== 'used'): `{ category: 'memory', scope, path, mtimeMs }`
- **D-11a:** For MCP servers, include both `definite-ghost` and `likely-ghost` tiers in the hash because Phase 8 will disable all non-used ghost MCP servers (they're expensive and the user explicitly opted in via `--dangerously-bust-ghosts`). For agents/skills, only `definite-ghost` qualifies for archive (likely-ghost is monitor-only, per Phase 5 D-12). This distinction is intentional: MCP token cost per server is ~10x agent/skill cost, so the criterion for action is wider for MCP.
- **D-12:** Canonicalization algorithm:
  1. Build the record array for all three categories
  2. Sort by `(category, scope, projectPath ?? '', path ?? serverName)` using `String.localeCompare` with deterministic locale (`'en-US-POSIX'`) — NOT default locale, which varies by OS
  3. Inside each record, serialize with stable key order: always `category, scope, projectPath, path, mtimeMs, serverName, sourcePath, configMtimeMs` (null fields omitted for compactness)
  4. `JSON.stringify(sortedArray)` — single line, no spacing
  5. `crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex')`
  6. Final `ghost_hash` value = `"sha256:" + hexDigest` (literal prefix per handoff §105)
- **D-13:** `mtimeMs` normalization: use raw integer milliseconds from `fs.stat` (or `InventoryItem.mtimeMs` where already populated, as in memory scanner). No truncation to seconds, no content hashing. File-open-for-stat happens once per item in a Promise.all batch to avoid sequential stat overhead.
- **D-14:** `configMtimeMs` for MCP records is computed once per unique `sourcePath` (e.g., `~/.claude.json`, `<project>/.mcp.json`) and reused across every server declared in that file. The stat result is cached in a `Map<sourcePath, mtimeMs>` for the duration of the hash build.
- **D-15:** The `--since` window is **NOT** part of the hash. A dry-run with `--since 30d` can satisfy a bust with `--since 7d` provided the archive-eligible set is identical. This was an explicit call: narrower semantics would force users to match flags between phases, which is surprise-prone. Phase 8's block message will show the dry-run's `since_window` for operator clarity (see D-17).
- **D-16:** Tier itself is NOT in the hash beyond the filter in D-11 — the hash cares about the identity of archive-eligible items, not about transient classification fluctuations. If an item transitions definite-ghost → likely-ghost (e.g., the user invoked it once), it drops out of the hash input, so the hash changes and the checkpoint invalidates. This is the correct behavior: the bust list shrunk.

### Checkpoint file schema
- **D-17:** Checkpoint body is a single JSON object with the following fields (all mandatory unless noted):
  ```json
  {
    "checkpoint_version": 1,
    "ccaudit_version": "0.1.0",
    "timestamp": "2026-04-04T18:30:00.000Z",
    "since_window": "7d",
    "ghost_hash": "sha256:abc123...",
    "item_count": {
      "agents": 128,
      "skills": 82,
      "mcp": 4,
      "memory": 6
    },
    "savings": {
      "tokens": 94000
    }
  }
  ```
  `checkpoint_version: 1` is a fixed integer — Phase 8 reads this and refuses checkpoints with an unknown version. `ccaudit_version` is sourced from `apps/ccaudit/package.json` at build time (NOT runtime — must survive bundling). `timestamp` is ISO-8601 UTC. `since_window` is the raw `--since` string the user passed (e.g., `"7d"`). `item_count.memory` is added beyond the handoff baseline because the change plan includes flagged memory files (D-07). `savings.tokens` is the raw integer count (not the `"~94k"` display form) so Phase 8 can re-render with its own locale.
- **D-18:** Checkpoint file lives at `~/.claude/ccaudit/.last-dry-run` (literal path from handoff §102, dotfile, legacy-path only). ccaudit does NOT write a parallel XDG copy — there is exactly one global ghost inventory and one checkpoint, regardless of which Claude path the user's sessions happen to live under. The directory is created on first dry-run with `fs.mkdir(dir, { recursive: true, mode: 0o700 })`. File permissions on the checkpoint itself: `0o600` (user read/write only).
- **D-19:** Checkpoint write uses the **atomic write pattern** (write to temp, then rename): write to `~/.claude/ccaudit/.last-dry-run.tmp-<pid>`, `fs.writeFile()` the JSON body, then `fs.rename()` onto `~/.claude/ccaudit/.last-dry-run`. This prevents a half-written checkpoint from surviving a crashed process. This is the same pattern Phase 8 will use for `~/.claude.json` mutations (RMED-09) — Phase 7 establishes it on the simpler target first.
- **D-20:** Checkpoint errors are fatal for the dry-run command: if the directory cannot be created or the file cannot be written (permissions, disk full, read-only home), the command prints an error to stderr and sets `process.exitCode = 2` (distinct from other Phase 6 exit codes which use 0 and 1). The change-plan output is still rendered to stdout first so users can see what WOULD have happened; only the checkpoint failure propagates to exit code.

### Claude's Discretion
- Exact wording of footer CTA line after checkpoint write (`"Checkpoint written. Run ccaudit --dangerously-bust-ghosts to apply changes."` or similar)
- Module placement inside `@ccaudit/internal` — recommend `packages/internal/src/remediation/` directory with `change-plan.ts` (data model + builder), `checkpoint.ts` (hash + read + write), and barrel re-exports through `packages/internal/src/index.ts`. Phase 8 will also use this directory.
- Human-relative last-used formatting in the `--verbose` listing (`"3 days ago"` vs `"2026-04-01"`) — follow whatever Phase 5 top-5 list uses
- Column widths and spacing in the grouped summary (align counts right, paths truncated at terminal width)
- Where `ccaudit_version` is injected at build time — recommend tsdown `define` or a generated `version.ts`; planner decides
- In-source test fixture layout — follow Phase 3/4 tmpdir convention
- CSV column schema when `--dry-run --csv` (recommend: `action,category,name,scope,projectPath,path,tokens,tier` — one row per affected item)
- JSON envelope field ordering within the Phase 6 `meta` wrapper (Phase 6 D-16 says field order is Claude discretion)
- Whether the `--dry-run` JSON schema includes the full canonical hash input list (debugging aid) or just the final `ghost_hash` — recommend final hash only to keep the envelope small; verbose users can inspect the checkpoint file

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — DRYR-01, DRYR-02, DRYR-03 (Phase 7 requirements); RMED-02 (Phase 8 gate that consumes our checkpoint)
- `.planning/ROADMAP.md` — Phase 7 success criteria, Phase 8 dependency chain
- `.planning/PROJECT.md` — Key Decisions table: "Hash-based checkpoint expiry", "Archive not delete", "Key-rename not comment-out for MCP", "Running-process gate" (Phase 8 context only)

### Handoff doc (authoritative UX mockups)
- `docs/ccaudit-handoff-v6.md` lines 84–117 — Dry-run mode + Checkpoint Enforcement spec (timestamp/ghost_hash/item_count shape, 3-gate flow)
- `docs/ccaudit-handoff-v6.md` lines 122–161 — Triple confirmation UX (the viral asset; Phase 7 change-plan layout mirrors lines 127–143)
- `docs/ccaudit-handoff-v6.md` lines 378–379 — Open Question 8: hash-based vs time-based expiry rationale (resolved: hash-based is correct)

### Prior CONTEXT
- `.planning/phases/05-report-cli-commands/05-CONTEXT.md` — D-06 through D-10 (branding, emoji, dividers, header format) — reused by `renderChangePlan`; D-12 (recommendation mapping) — constrains the filter in D-07
- `.planning/phases/06-output-control-polish/06-CONTEXT.md` — D-01 through D-20 (exit codes, color, quiet, verbose, CI, JSON envelope, CSV schema) — `--dry-run` must honor all of these

### Existing code (integration points)
- `apps/ccaudit/src/cli/commands/ghost.ts` — Current ghost command handler. `--dry-run` branch will live here; default rendering path splits when `ctx.values.dryRun === true`.
- `apps/ccaudit/src/cli/_shared-args.ts` — `outputArgs` (shared `quiet`, `csv`, `ci`); extend the ghost command's own `args` with `dryRun`.
- `apps/ccaudit/src/cli/_output-mode.ts` — `resolveOutputMode` + `buildJsonEnvelope` (reused unchanged).
- `packages/internal/src/scanner/index.ts` — `scanAll()` produces the `ScanResult[]` that feeds the change plan.
- `packages/internal/src/token/index.ts` — `enrichScanResults()` adds `tokenEstimate` needed for D-08 savings calculation; `calculateTotalOverhead()` is the pattern to mimic for savings math.
- `packages/internal/src/report/recommendation.ts` — `classifyRecommendation(tier)` already implements the archive/monitor/keep map. Phase 7 filters `recommendation === 'archive'` for agents/skills.
- `packages/internal/src/scanner/scan-mcp.ts` — `ClaudeConfig` interface + `readClaudeConfig()` understand both `~/.claude.json` root `mcpServers` and `projects.<path>.mcpServers` + `.mcp.json`. Source paths for `configMtimeMs` computation come from here.
- `packages/internal/src/scanner/types.ts` — `InventoryItem.mtimeMs` (memory files already populate it; agents/skills need a `fs.stat` pass in Phase 7).
- `packages/terminal/src/index.ts` — `renderHeader`, `humanizeSinceWindow`, `csvTable`, `tsvRow`, `initColor`, `colorize` — all reused. Add `renderChangePlan` and `renderChangePlanVerbose` next to `tables/ghost-table.ts`.
- `packages/terminal/src/tables/ghost-table.ts` line 95 — Current footer: `"Dry-run coming in v1.1: npx ccaudit@latest --dry-run"`. Phase 7 either removes this line entirely (now that dry-run ships) or leaves it in non-dry-run mode as a discovery hint. Recommend: keep in non-dry-run footer, suppress when `--dry-run` is active (replaced by checkpoint confirmation line).

### Cryptography
- Node.js built-in `crypto.createHash('sha256')` — zero dependency; matches the "no runtime deps" constraint. No third-party hash libraries.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`scanAll()` + `enrichScanResults()`** produce `TokenCostResult[]` with everything Phase 7 needs: `item.path`, `item.scope`, `item.projectPath`, `item.category`, `tier`, `tokenEstimate.tokens`, `invocationCount`. The change-plan builder is a pure function over this array — no new scanner logic required.
- **`classifyRecommendation(tier)`** in `packages/internal/src/report/recommendation.ts` already maps tiers to `archive | monitor | keep`. Phase 7's change-plan filter reuses this: `recommendation === 'archive'` for agents/skills; MCP widens to `tier !== 'used'` per D-11a; memory uses `tier !== 'used'`.
- **`calculateTotalOverhead(ghosts)`** in `packages/internal/src/token/estimate.ts` is the shape for the new `calculateDryRunSavings(plan)` helper — sum `tokenEstimate?.tokens ?? 0` over filtered items.
- **`@ccaudit/terminal` renderers** (`renderHeader`, `humanizeSinceWindow`, `initColor`, `colorize`, `csvTable`, `tsvRow`, `renderGhostFooter`) handle all the Phase 5/6 branding and output-mode concerns. Phase 7 adds one new renderer (`renderChangePlan`) and one verbose augmentation.
- **`outputArgs` + `resolveOutputMode` + `buildJsonEnvelope`** give dry-run every output mode "for free" — Phase 6 abstracted these precisely so new commands/flags don't reimplement them.
- **`ClaudeConfig` interface** in `scan-mcp.ts` already exports the `mcpServers` + `projects.<path>.mcpServers` shape Phase 7 needs for `sourcePath` resolution.

### Established Patterns
- **gunshi `define()` boolean flag** — add `dryRun: { type: 'boolean', description: '...', default: false }` to the ghost command's `args`; gunshi handles `--dry-run` kebab-case automatically. Mirror how `json` and `verbose` are declared in the same file.
- **Output-mode branching** — the ghost command already uses an `if (mode.json) {} else if (mode.csv) {} else if (mode.quiet) {} else {}` chain. Dry-run adds an orthogonal axis: wrap each branch with `if (ctx.values.dryRun) { ...plan... } else { ...inventory... }`, OR lift the decision earlier (`const plan = ctx.values.dryRun ? buildChangePlan(enriched) : null`) and route once. Recommend the latter — single decision point, easier to test.
- **Atomic write** via tmp + rename is NOT yet in the codebase (Phase 7 is the first user). Use `randomUUID().slice(0, 8)` or `process.pid` for the tmp suffix. `node:fs/promises` has both `writeFile` and `rename`.
- **In-source tests** live in the same file as the code under test, gated by `if (import.meta.vitest)`. Follow the conventions in `recommendation.ts` and `estimate.ts`.
- **Silent error handling** (from `readClaudeConfig`): return an empty/safe default rather than throwing, UNLESS the user's action depends on the write succeeding. Checkpoint write is an exception (D-20) — it must fail loudly.
- **`InventoryItem.mtimeMs`** is already populated for memory files by `scanMemoryFiles`. Phase 7 adds a `fs.stat` pass during change-plan build for agents and skills (their scanners don't currently populate mtimeMs). One `Promise.all` batch, stat result cached per path.
- **JSON envelope** from `buildJsonEnvelope('ghost', sinceStr, exitCode, payload)` — dry-run uses `buildJsonEnvelope('ghost', sinceStr, exitCode, { dryRun: true, changePlan: {...}, checkpoint: {...} })`. No new envelope function needed.

### Integration Points
- **`apps/ccaudit/src/cli/commands/ghost.ts`**: add `dryRun` flag to `args`, branch early on `ctx.values.dryRun`, route to change-plan path.
- **`packages/internal/src/remediation/`** (new directory): `change-plan.ts` (types + `buildChangePlan()`), `savings.ts` (`calculateDryRunSavings()`), `checkpoint.ts` (`computeGhostHash()`, `readCheckpoint()`, `writeCheckpoint()`).
- **`packages/internal/src/index.ts`**: add barrel exports for the new `remediation` module.
- **`packages/terminal/src/tables/change-plan.ts`** (new): `renderChangePlan(plan, mode)` + `renderChangePlanVerbose(plan)`.
- **`packages/terminal/src/index.ts`**: export the new renderers.
- **`packages/terminal/src/tables/ghost-table.ts`** line 95: suppress the "Dry-run coming in v1.1" hint when `--dry-run` is active; leave it in non-dry-run mode as a discovery hint until v1.2.

</code_context>

<specifics>
## Specific Ideas

- The grouped-by-action layout (D-06) is deliberately a near-copy of handoff §127–143. The remediation UX is the viral asset — dry-run previewing the EXACT same visual is what makes `ccaudit --dry-run` screenshots recognizable as "the companion to `--dangerously-bust-ghosts`".
- Phase 7 is the first v1.1 phase and the first code path that will be read by Phase 8. Every decision captured here is a contract: the hash algorithm (D-12), the canonical record shape (D-11), the checkpoint schema (D-17), and the directory/path/atomic-write (D-18/D-19) are ALL consumed by Phase 8's RMED-02 gate. Phase 8 planning should start from this CONTEXT file unchanged.
- The savings number (D-08) is the headline the user will quote ("I saved 94k tokens with ccaudit!"). Calculating it from definite-ghost archive/disable items only (not memory, not likely-ghost) means the number is honest — what `--dangerously-bust-ghosts` will actually reclaim on the next run. Inflated numbers at v1.1 launch will turn into "ccaudit lied" tweets at v1.2 launch.
- `checkpoint_version: 1` is a forward-compatibility hedge. If we ever need to add fields that Phase 8 must understand (e.g., `hash_algorithm: 'sha256'` for a future sha3 upgrade), we bump to 2 and Phase 8 can reject 1 or migrate it.
- The tmp-file + rename pattern (D-19) is intentionally established here on a low-stakes target so Phase 8's higher-stakes `~/.claude.json` mutation can reuse the same code path (probably extracted into `@ccaudit/internal`).
- Exit code 2 for checkpoint failure (D-20) is a new distinction — Phase 6 only uses 0 and 1. We choose 2 because confusing "ghosts found" (1) with "checkpoint write failed" (2) would break CI scripts.

</specifics>

<deferred>
## Deferred Ideas

- **Per-item plan inspection via `ccaudit --dry-run --list` or a dedicated subcommand** — power-user feature. `--verbose` (D-09) covers the need without a new flag.
- **Checkpoint history / rollback** — storing multiple past checkpoints for forensics. Not needed for v1.1; v1.2 restore already gives users an undo path.
- **Per-project scoped checkpoints** — only useful if dry-run ever gets scoped to a single project. v1.1 is global-only; defer to v2 if user demand materializes.
- **SHA-3 / BLAKE3 hash upgrade** — SHA-256 is sufficient for v1.x; `checkpoint_version` leaves room to migrate later.
- **Dry-run TUI / interactive selection** (pick which ghosts to bust) — conflicts with the viral "one command, all ghosts" UX. v2+ only.
- **Checkpoint TTL in addition to hash** — explicitly rejected: hash-based expiry is correct per PROJECT.md Key Decision and handoff §378–379. No time-based expiry under any circumstances.
- **Writing the checkpoint to XDG path when `XDG_CONFIG_HOME` is set** — considered in D-18, rejected. Single global checkpoint; dual-path is read-only for scanning.

</deferred>

---

*Phase: 07-dry-run-checkpoint*
*Context gathered: 2026-04-04*

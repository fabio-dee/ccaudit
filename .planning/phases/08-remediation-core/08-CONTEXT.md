# Phase 8: Remediation Core - Context

**Gathered:** 2026-04-05
**Status:** Ready for planning

<domain>
## Phase Boundary

`ccaudit --dangerously-bust-ghosts` executes the preview that Phase 7 rendered — archiving ghost agents/skills, key-renaming ghost MCP servers in `~/.claude.json`, flagging stale memory files with frontmatter — behind a layered safety model (checkpoint verification, running-process preflight, two-prompt confirmation, atomic writes) and producing an incremental restore manifest that Phase 9 will consume. This phase owns destructive-but-reversible execution. It does NOT own rollback (`ccaudit restore` — Phase 9) or community contribution (`ccaudit contribute` — Phase 10).

The viral UX asset (`--dangerously-bust-ghosts` flag + typed-phrase ceremony) lives here. The phase MUST also pass Success Criterion 9: extend the CI matrix to `windows-latest` and prove `fs.rename` EPERM retry logic with exponential backoff.

</domain>

<decisions>
## Implementation Decisions

### Safety gates (RMED-02, RMED-03)

- **D-01:** **Two-gate checkpoint verification, not three.** Gate #1: checkpoint file exists at `~/.claude/ccaudit/.last-dry-run`. Gate #2: `computeGhostHash(enriched)` on the current inventory equals `checkpoint.ghost_hash`. The "checkpoint is recent" gate #3 from RMED-02 is **dropped** — it conflicts with the PROJECT.md Key Decision ("Hash-based checkpoint expiry … time-based is wrong") and Phase 7 D-15 (hash is sole signal). `REQUIREMENTS.md` RMED-02 needs a clarifying amendment during planning ("recent" wording was a stale leftover from handoff §113's pre-decision ≤24h rule). Gate #2 already catches "stale dry-run": if inventory changed, hash changed, gate #2 fails with the same UX.

- **D-02:** **Running-process detection via `ps`/`tasklist` scan.** Spawn `ps -A -o comm=` on Unix, `tasklist /FO CSV /NH` on Windows. Parse output, filter for a conservative pattern matching the Claude Code binary name (exact match on `claude` / `Claude.exe` / `Claude Code` — researcher to validate exact executable names during phase-researcher step). Exclude our own pid + parent-chain ancestors for the generic "is any Claude Code running?" check (see D-04 for the self-invocation subcase). Zero runtime deps — uses `node:child_process.spawn` only. Fallback: if `ps`/`tasklist` fails to spawn (not on PATH, permission denied), treat as "cannot verify" and refuse with a distinct message ("could not verify Claude Code is stopped — run from a clean shell").

- **D-03:** **On positive detection: refuse, exit 3, no bypass flag.** Exit code 3 is reserved for "running-process preflight failure" and is distinct from Phase 6 exit 0/1 (ghost status) and Phase 7 exit 2 (checkpoint write failure). The refusal message prints the pids and binary paths found: `Claude Code is running (pids: 12345, 67890). Close all Claude Code windows and re-run ccaudit --dangerously-bust-ghosts.` No override flag — this gate protects the user from concurrent `~/.claude.json` writes which corrupt OAuth tokens; no legitimate workflow requires bypassing it.

- **D-04:** **Self-invocation sub-case has a tailored message.** If any detected pid is in ccaudit's own parent-process chain (ccaudit was spawned from inside a Claude Code session, typically via the Bash tool), the error reads: `You appear to be running ccaudit from inside a Claude Code session (parent pid: 12345). Open a standalone terminal and run this command there.` Same exit code (3), same no-bypass policy — we intentionally want this failure mode to protect users from the Bash-tool-inside-Claude-Code footgun.

### Archive & key-rename collisions (RMED-04, RMED-05, RMED-06)

- **D-05:** **Archive filename collisions resolved by ISO timestamp suffix.** First-time archive: `~/.claude/agents/code-reviewer.md → ~/.claude/agents/_archived/code-reviewer.md`. On collision (prior bust + never restored + same name recreated and re-ghosted), suffix the archived filename with the current UTC ISO timestamp (colons replaced with dashes for filesystem safety): `_archived/code-reviewer.2026-04-05T18-30-00Z.md`. The exact archive path is recorded in the restore manifest so Phase 9 can find the right version. Sortable, readable, preserves history. Same policy for skills. Archive directories created with `fs.mkdir(..., { recursive: true, mode: 0o700 })`.

- **D-06:** **MCP `ccaudit-disabled:<name>` key collisions resolved by ISO timestamp suffix on the key.** First bust: `mcpServers.playwright → ccaudit-disabled:playwright`. On collision: `ccaudit-disabled:playwright:2026-04-05T18-30-00Z`. Restore manifest records the exact key, so Phase 9 finds the right entry to rename back. Consistent with the archive collision policy. Note: the colon in the suffix is a literal key character (JSON keys permit any UTF-8), not a nested path delimiter.

- **D-07:** **Memory re-flag is an idempotent timestamp refresh, not a skip.** When a memory file already carries `ccaudit-stale: true`, the current bust updates `ccaudit-flagged: <now>` to reflect that the current-day stale heuristic still matched the file. The `ccaudit-stale: true` key stays as-is. Verbose output logs: `· refreshed ccaudit-stale flag on CLAUDE.md (was flagged 2026-03-01)`. The manifest records a `refresh` op type (distinct from `flag`) so Phase 9 restore can make an informed decision about whether to strip the flag entirely or leave it.

- **D-08:** **Hand-rolled YAML frontmatter patcher, zero external dep.** Read file → scan for a leading `---\n...\n---` block → if present, look for existing `ccaudit-stale:` / `ccaudit-flagged:` keys and update their values in-place (line-based, preserves unrelated keys and formatting); if absent, inject both keys on new lines before the closing `---`. If no frontmatter block exists at all, prepend a freshly built one (`---\nccaudit-stale: true\nccaudit-flagged: <iso>\n---\n\n` followed by the original file body). **Malformed or exotic frontmatter** (nested structures, multi-line strings, folded YAML scalars, arrays beyond simple top-level key:value pairs) must be detected and the file skipped with a verbose warning — the manifest records a `skipped` op for that file. Fixtures required: no frontmatter / empty frontmatter / frontmatter with unrelated keys / frontmatter with existing ccaudit keys / malformed frontmatter / Windows CRLF line endings.

### Restore manifest (Phase 9 contract) (RMED-08)

- **D-09:** **JSONL format, one op per line, `fs.open(path, 'a')` + `fd.write(line + '\n')` + `fd.sync()` per op.** Each op is a standalone JSON object written with a trailing newline. `fd.sync()` after every append makes the bust survive crash-at-any-point with up to one truncated final line (Phase 9 reader must tolerate and skip a trailing non-parseable line). The file descriptor is opened once at bust start, closed once at bust end. No in-memory buffering that could be lost on SIGKILL.

- **D-10:** **Per-bust timestamped file at `~/.claude/ccaudit/manifests/bust-<ISO>.jsonl`.** Directory created on first bust with `mkdir({ recursive: true, mode: 0o700 })`. File permissions: `0o600`. Example path: `~/.claude/ccaudit/manifests/bust-2026-04-05T18-30-00Z.jsonl` (colons in the timestamp replaced with dashes for cross-platform filesystem safety, matching D-05). Phase 9 discovery: `ccaudit restore` (no args) picks the newest manifest file by mtime; `ccaudit restore --list` sorts all manifests. Full bust history is preserved without any pointer file or symlink.

- **D-11:** **Full per-op schema with content hashes.** Every line is a JSON object with: `{ op_id: <uuidv4>, op_type: 'archive' | 'disable' | 'flag' | 'refresh' | 'skipped', timestamp: <iso-8601>, status: 'completed' | 'failed', error?: <string> }` plus per-type fields:
  - **archive:** `{ category: 'agent' | 'skill', scope, source_path, archive_path, content_sha256 }` — content_sha256 computed from the original file bytes before the move; Phase 9 uses it to detect post-bust tampering.
  - **disable:** `{ config_path, scope, project_path, original_key, new_key, original_value }` — `original_value` is the full JSON subtree that was under the original key (so Phase 9 can restore the exact config even if the surrounding file was modified between bust and restore).
  - **flag:** `{ file_path, scope, had_frontmatter: boolean, had_ccaudit_stale: boolean, patched_keys: ['ccaudit-stale', 'ccaudit-flagged'], original_content_sha256 }`.
  - **refresh:** `{ file_path, scope, previous_flagged_at }` (the timestamp that was replaced).
  - **skipped:** `{ file_path, category, reason }` — emitted for malformed-frontmatter (D-08) and other skip conditions so Phase 9 understands why an item the user expected to be processed was not.

- **D-12:** **Header record (first line) + footer record (last line, only on success).**
  - **Header (line 1, written before any ops begin):** `{ record_type: 'header', manifest_version: 1, ccaudit_version, checkpoint_ghost_hash, checkpoint_timestamp, since_window, os: <'darwin'|'linux'|'win32'>, node_version, planned_ops: { archive: N, disable: M, flag: K } }`. Written and fsynced before the first op, so even a very early crash leaves a discoverable "a bust started but never finished" marker.
  - **Footer (last line, written only on successful completion of all ops):** `{ record_type: 'footer', status: 'completed', actual_ops: { archive: { completed, failed }, disable: { completed, failed }, flag: { completed, failed, refreshed, skipped } }, duration_ms, exit_code }`.
  - **Phase 9 detection rule:** header-present + footer-present = clean bust, restore normally. header-present + footer-missing = crashed mid-bust, print "partial bust detected" warning to the user before doing a best-effort restore of the ops that were recorded. Header-missing = corrupt manifest, refuse.

### Operation execution & confirmation (RMED-09, RMED-10)

- **D-13:** **Execution order: Archive agents → Archive skills → Disable MCP → Flag memory.** Filesystem-only ops first (lowest blast radius), then the risky `~/.claude.json` mutation (behind the running-process gate established in D-02), then the additive frontmatter patch. Rationale: if Disable MCP fails after Archive succeeds, the manifest reflects that cleanly and Phase 9 partial-restore works. Reversing the order would mean a failed Archive after a successful Disable leaves the user's MCP disabled with no apparent cause from their perspective.

- **D-14:** **Hybrid failure policy.**
  - **Independent fs ops** (each agent archive, each skill archive, each memory flag patch) use **continue-on-error**: on error, write a manifest line with `status: 'failed'` + error string, keep going on the rest of the category. Summary at the end reports `<N successful, M failed>` per category.
  - **`~/.claude.json` mutation** (Disable MCP step) uses **fail-fast**: the entire file is read, mutated in memory (key-renames applied), then atomically written via the Phase 7 D-19 write-to-tmp-then-rename pattern. Any error before the rename (parse error, invalid in-memory state, write failure) aborts the Disable MCP step WITHOUT committing any of its rename ops to the manifest. The JSON blob is transactional — all rename ops succeed and get written, or none do.
  - **Final exit code:** 0 if all ops completed successfully, 1 if any op in any category failed (including partial-success cases). Distinct from exit 2 (Phase 7 checkpoint write failure), 3 (running-process preflight), and 4 (non-TTY without bypass — see D-17).

- **D-15:** **Two-prompt confirmation ceremony** — the viral UX asset, restructured from the handoff §145-150 three-prompt design into a two-prompt version at user request.
  ```
  [1/2] Proceed busting? [y/N]:
  > y

  [2/2] Type exactly: proceed busting
  > proceed busting
  ```
  - **Prompt 1** is a y/N confirmation. `y` or `Y` accepts; anything else (including Enter, `n`, `no`, Ctrl+C) aborts with `Aborted by user.` and exit code 0.
  - **Prompt 2** is a typed-phrase ceremony. Input is trimmed of leading/trailing whitespace, then compared case-sensitively against the literal string `proceed busting`. On mismatch: print `(typo — try again)` and re-prompt, up to 3 retries. After 3 failed attempts: `Aborted — confirmation phrase mismatch` with exit code 0.
  - The typed-phrase step keeps the screenshot-friendly ceremony (still a tweet: "this CLI made me type 'proceed busting' before cleaning up") while being faster to execute than the original `I accept full responsibility` phrase.
  - Above the prompts, the `renderChangePlan(plan)` output from Phase 7 is displayed verbatim (grouped ARCHIVE / DISABLE / FLAG sections with counts and savings), ensuring the user sees exactly what they are authorizing.

- **D-16:** **`--yes-proceed-busting` is the non-TTY / power-user bypass flag.** The flag name is deliberately coupled to the typed phrase from D-15 — both interactive and non-TTY users say the same thing. The flag is intentionally unwieldy to prevent copy-paste accidents from shell scripts. When present, both prompts from D-15 are skipped entirely (no display of the change plan above, either — assume the caller knows). The flag is valid in both TTY and non-TTY contexts; in TTY it is a power-user shortcut, in non-TTY it is mandatory.

- **D-17:** **Non-TTY behavior: refuse with exit 4 unless `--yes-proceed-busting` is present.** Detect TTY via `process.stdin.isTTY`. If `false` (piped, `script`, GitHub Actions, CI, Docker entrypoint, etc.) and `--yes-proceed-busting` is not set, exit with code 4 and message: `ccaudit --dangerously-bust-ghosts requires an interactive terminal. To run non-interactively, pass --yes-proceed-busting (only if you understand what you are doing).`. Exit code 4 is reserved for "non-TTY without bypass" — distinct from exit 3 (running-process) so CI scripts can tell the two preflight failures apart.

### Atomic write pattern (RMED-09)

- **D-18:** **Reuse the Phase 7 D-19 atomic write pattern unchanged, extract to a shared helper.** Write to `<target>.tmp-<pid>-<random8>` in the same directory as the target, `fs.writeFile()` the serialized JSON body, then `fs.rename()` onto the final path. File mode `0o600`, directory mode `0o700`. The current Phase 7 implementation in `packages/internal/src/remediation/checkpoint.ts` should be extracted to a shared helper module (recommend `packages/internal/src/remediation/atomic-write.ts` exporting `atomicWriteJson(path, value)`) so both the checkpoint writer and the `~/.claude.json` mutator use the same code path. The extraction is a refactor that MUST NOT change Phase 7 behavior (regression tests from Phase 7 must still pass).

### Claude's Discretion

The following choices are deferred to the researcher and planner. The user does not need to weigh in during planning; Claude has flexibility within the above constraints.

- **Windows EPERM retry schedule** — Success Criterion 9 mandates exponential-backoff retry on `fs.rename` EPERM (the Windows virus-scanner race condition). Exact retry count, initial backoff, max backoff, total timeout — researcher to investigate ccusage, fs-extra, and Node core issue trackers for the canonical pattern. Applies to archive renames (D-05), atomic-write renames (D-18), and manifest-file renames if any.
- **Output mode applicability matrix for bust** — does `--json` produce a structured bust report? Does `--quiet` suppress progress log lines? Does `--ci` imply `--yes-proceed-busting`? Does `--verbose` log per-op detail to stderr? Planner to propose a matrix and explicitly honor or reject each Phase 6 output mode on the bust command.
- **Exit code ladder consolidation** — 0 (clean), 1 (op failures), 2 (checkpoint write failure, Phase 7), 3 (running-process preflight), 4 (non-TTY without bypass). Planner to add a canonical exit code table to the README / `docs/JSON-SCHEMA.md` so CI users can distinguish failure categories.
- **Progress rendering during bust** — TUI progress bars (handoff §152-155 mockup) vs simple log lines vs nothing. Planner's call; prefer the simplest thing that works under `--quiet` and `--no-color`.
- **Exact stderr wording** for the D-03, D-04, D-17 refusal messages — follow Phase 6 verbose-to-stderr precedent.
- **Module layout inside `packages/internal/src/remediation/`** — recommend: `bust.ts` (orchestrator), `manifest.ts` (JSONL append + schema types), `processes.ts` (ps-scan detection), `frontmatter.ts` (YAML patcher), `atomic-write.ts` (extracted helper from D-18), `collisions.ts` (ISO-timestamp suffix helpers). Planner may consolidate.
- **UUID generation for `op_id` (D-11)** — Node `crypto.randomUUID()` is zero-dep and sufficient.
- **Fixture strategy for Windows CI** — tmpdir + mocked ps/tasklist output, OR full OS matrix runs. Recommend both: unit tests with mocked output for cross-platform CI, plus one integration test on `windows-latest` that exercises the EPERM retry path.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — RMED-01 through RMED-10 (Phase 8 scope); RMED-11 through RMED-13 (Phase 9 consumes the manifest this phase writes)
- `.planning/ROADMAP.md` — Phase 8 section, Success Criteria especially SC #9 (Windows matrix + EPERM retry)
- `.planning/PROJECT.md` — Key Decisions table: "Hash-based checkpoint expiry" (time-based rejected), "Archive not delete for agents/skills", "Key-rename not comment-out for MCP", "Running-process gate before ~/.claude.json mutation"
- `.planning/REQUIREMENTS.md` RMED-02 — **needs amendment during planning**: gate #3 "checkpoint is recent" is dropped per D-01 in favor of hash-only gating, matching the PROJECT.md Key Decision

### Handoff doc (UX contract)
- `docs/ccaudit-handoff-v6.md` §78-94 — The three operation modes and the `--dangerously-bust-ghosts` framing
- `docs/ccaudit-handoff-v6.md` §97-117 — Dry-run checkpoint enforcement (written by Phase 7, verified by Phase 8 via D-01)
- `docs/ccaudit-handoff-v6.md` §122-161 — Remediation UX mockup (**Phase 8 deviates at §145-149**: the three-prompt ceremony becomes two-prompt per D-15; the phrase `I accept full responsibility` becomes `proceed busting`; the `--yes-i-accept-full-responsibility` flag becomes `--yes-proceed-busting` per D-16)
- `docs/ccaudit-handoff-v6.md` §169-220 — Remediation mechanics (archive / key-rename / frontmatter flag); Phase 8 implements this + D-05, D-06, D-07, D-08 define collision handling beyond the handoff

### Prior CONTEXT (contracts Phase 8 consumes)
- `.planning/phases/07-dry-run-checkpoint/07-CONTEXT.md` — **primary upstream contract**:
  - D-10 through D-14: hash input scope, canonical record shape, hash algorithm (Phase 8 reuses `computeGhostHash()` for gate #2)
  - D-15: `--since` window is NOT in the hash (Phase 8 honors the same)
  - D-17: checkpoint schema (Phase 8 reads and validates `checkpoint_version: 1`, rejects unknown versions)
  - D-18: checkpoint path `~/.claude/ccaudit/.last-dry-run` (Phase 8 reads here)
  - D-19: atomic write pattern (Phase 8 reuses verbatim per D-18 above; extraction to shared helper is a refactor)
  - D-20: exit code 2 for checkpoint *write* failure (Phase 8 uses 3 and 4 for new preflight categories — see D-03, D-17)
- `.planning/phases/06-output-control-polish/06-CONTEXT.md` — D-01 through D-20 (exit codes, color control, quiet, verbose, CI, JSON envelope, CSV schema); Phase 8 output-mode applicability is Claude's discretion but must honor these base semantics where relevant
- `.planning/phases/05-report-cli-commands/05-CONTEXT.md` — D-06 through D-10 (emoji, dividers, header format); `renderChangePlan` above the confirmation prompts reuses the Phase 5/7 branding

### Existing code (integration points)
- `packages/internal/src/remediation/checkpoint.ts` — `computeGhostHash(enriched, statFn?)`, `readCheckpoint()`, `writeCheckpoint()`, `resolveCheckpointPath()`, `Checkpoint` type. Phase 8 calls `readCheckpoint()` then re-computes hash and compares. Also the source of the atomic write pattern to be extracted per D-18.
- `packages/internal/src/remediation/change-plan.ts` — `buildChangePlan(enriched)`, `ChangePlan`, `ChangePlanItem`, `ChangePlanAction`. Phase 8 rebuilds the plan from a fresh scan (checkpoint does not persist the plan — only the hash — so re-scan is required).
- `packages/internal/src/remediation/savings.ts` — `calculateDryRunSavings(plan)`. Reused for the post-bust summary ("Saved ~Xk tokens").
- `packages/internal/src/remediation/index.ts` — Add exports for new Phase 8 modules (bust orchestrator, manifest writer, processes detection, frontmatter patcher).
- `packages/internal/src/scanner/scan-mcp.ts` — `ClaudeConfig` interface, `readClaudeConfig()`. Phase 8 reads `~/.claude.json` through this path, mutates the parsed object, writes back atomically.
- `packages/internal/src/scanner/index.ts` — `scanAll()` produces the `ScanResult[]` that feeds enrichment → plan build → hash verify → execution.
- `packages/internal/src/token/index.ts` — `enrichScanResults()` (same pipeline Phase 7 uses).
- `packages/terminal/src/tables/change-plan.ts` — `renderChangePlan(plan)` (Phase 7). Phase 8 displays this above the D-15 prompts.
- `apps/ccaudit/src/cli/commands/ghost.ts` — Phase 7 `--dry-run` branch. Phase 8 adds a `--dangerously-bust-ghosts` branch alongside it (same command, third route: non-dry-run ghost display / dry-run preview / bust execution).
- `apps/ccaudit/src/cli/_shared-args.ts` — `outputArgs` will gain `dangerouslyBustGhosts` and `yesProceedBusting` (or they live on the ghost command directly — planner's call).
- `apps/ccaudit/src/cli/_output-mode.ts` — `resolveOutputMode`, `buildJsonEnvelope`. Phase 8 consults these for the output matrix deferred to Claude's discretion.

### Cross-platform & CI
- Success Criterion 9 (ROADMAP.md Phase 8) — `windows-latest` must be added to the CI matrix and a targeted test must verify the EPERM retry path on Windows
- Node core `fs.rename` docs + Node issue tracker — EPERM on Windows is a known Windows Defender / antivirus race condition; retry-with-backoff is the canonical workaround

### Cryptography & randomness
- `node:crypto.createHash('sha256')` — already used in Phase 7 checkpoint; reused for content hashes in the manifest (D-11)
- `node:crypto.randomUUID()` — zero-dep, used for manifest `op_id` (D-11)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`computeGhostHash(enriched)`** (`packages/internal/src/remediation/checkpoint.ts`) — Phase 7 already built the canonical hash. Phase 8's gate #2 is `computeGhostHash(await enrichScanResults(await scanAll())) === checkpoint.ghost_hash`. No re-implementation needed.
- **`readCheckpoint()`** (same file) — returns `ReadCheckpointResult` with the parsed checkpoint or a reason-tagged failure. Phase 8 pattern-matches on the failure reason to produce targeted error messages for gate #1.
- **`buildChangePlan(enriched)` + `calculateDryRunSavings(plan)`** — the bust command re-runs this pipeline to get the fresh plan for execution, then the hash check verifies the plan matches the checkpoint's preview.
- **Phase 7 atomic write in `writeCheckpoint()`** — the tmp + rename + mode-600 pattern is the template for the D-18 extraction. `~/.claude/ccaudit/.last-dry-run.tmp-<pid>` is the existing precedent; Phase 8's `~/.claude.json.tmp-<pid>-<random8>` follows the same shape.
- **`scanMcpServers()` + `readClaudeConfig()`** (`packages/internal/src/scanner/scan-mcp.ts`) — the read path for `~/.claude.json` + `projects.<path>.mcpServers` + `.mcp.json`. Phase 8's Disable MCP step reads through the same interface, mutates the parsed object, and writes back.
- **`renderChangePlan(plan)`** (`packages/terminal/src/tables/change-plan.ts`) — reused verbatim for the above-prompt display in D-15.
- **`outputArgs` + `resolveOutputMode()` + `buildJsonEnvelope()`** (`apps/ccaudit/src/cli/_shared-args.ts`, `_output-mode.ts`) — Phase 6 infrastructure. Phase 8 honors whichever modes the planner deems appropriate (Claude's discretion).
- **In-source test pattern** (`if (import.meta.vitest) { ... }`) — established in checkpoint.ts, change-plan.ts, savings.ts. Phase 8 modules follow the same convention.
- **`StatFn` dependency injection pattern** (checkpoint.ts) — precedent for injecting `ps`/`tasklist` output readers, manifest writers, and `fs.rename` in tests where ESM module namespace is non-configurable.

### Established Patterns
- **gunshi boolean flag via `define()`** — pattern already used for `json`, `verbose`, `quiet`, `dryRun` in `ghost.ts`. Phase 8 adds `dangerouslyBustGhosts` + `yesProceedBusting` (gunshi auto-kebabs to `--dangerously-bust-ghosts` + `--yes-proceed-busting`; `toKebab: true` is already required at command level per Phase 7 gap fix).
- **Silent read, loud write** — scanners fail silently (return empty), writers fail loudly with distinct exit codes (Phase 7 D-20). Phase 8 extends: D-03 → exit 3, D-17 → exit 4, D-14 → exit 1.
- **Phase 6 output routing precedence** (`json → csv → quiet TSV → rendered`) — Phase 8 must respect the else-if chain when emitting bust output under various modes.
- **`fs.open(path, 'a')` + `fd.sync()` for incremental writes** — NOT yet in the codebase; Phase 8 establishes it for the manifest (D-09). The pattern is simpler than the tmp+rename atomic write because append-only semantics mean existing content is never invalidated; the worst case is a truncated last line, which the Phase 9 reader must tolerate.
- **ISO 8601 UTC timestamp generation** — precedent in checkpoint.ts (`new Date().toISOString()`). Phase 8 strips colons for filesystem paths per D-05/D-06/D-10 (`.replace(/:/g, '-')`).
- **`crypto.createHash('sha256').update(bytes).digest('hex')`** — precedent in checkpoint.ts for `ghost_hash`; reused for content hashes in manifest (D-11).

### Integration Points
- **`packages/internal/src/remediation/`** — add new modules:
  - `bust.ts` — orchestrator: verify → preflight → confirm → execute → summary
  - `manifest.ts` — JSONL append helpers, header/footer builders, schema types
  - `processes.ts` — ps/tasklist scan, self-invocation detection, pid-chain walk
  - `frontmatter.ts` — hand-rolled YAML patcher (read → scan → patch → write)
  - `atomic-write.ts` — extracted from checkpoint.ts per D-18
  - `collisions.ts` — ISO-timestamp suffix helpers (path-safe, JSON-key-safe)
- **`packages/internal/src/remediation/index.ts`** — barrel export the new modules
- **`packages/internal/src/remediation/checkpoint.ts`** — refactor to call `atomic-write.ts` per D-18 extraction; Phase 7 regression tests must still pass
- **`apps/ccaudit/src/cli/commands/ghost.ts`** — add the `--dangerously-bust-ghosts` branch (third route alongside the non-dry-run default and the `--dry-run` branch)
- **`apps/ccaudit/src/cli/_shared-args.ts`** — (planner's call) whether `dangerouslyBustGhosts` / `yesProceedBusting` live here or on the ghost command directly
- **`.github/workflows/ci.yml`** — add `windows-latest` to the OS matrix; add a targeted job or test step that exercises the EPERM retry path (SC #9)
- **`README.md` + `docs/ccaudit-handoff-v6.md`** — update the triple-confirmation mockup to show the new two-prompt `proceed busting` ceremony (the handoff's `I accept full responsibility` phrasing is the pre-decision version; D-15/D-16 supersede)

</code_context>

<specifics>
## Specific Ideas

- **The viral phrase changed.** Handoff §149 said `Type exactly: I accept full responsibility`; Phase 8 D-15 replaces this with `Type exactly: proceed busting`. The typed-phrase ceremony survives (still a screenshotable moment, still a tweet) but is faster to type and lower-friction. README, docs, and any launch marketing copy must reflect the new phrase.
- **The non-TTY bypass flag name is deliberately unwieldy.** `--yes-proceed-busting` is long enough that no one copy-pastes it from Stack Overflow without meaning to. Asymmetry was considered (`--yes` interactive / `--yes-proceed-busting` non-TTY) and rejected — one incantation, two contexts.
- **Self-invocation from inside Claude Code is the footgun D-04 protects against.** A user running `ccaudit --dangerously-bust-ghosts` via Claude Code's Bash tool would concurrently mutate the `~/.claude.json` that the enclosing Claude Code session is actively using. That's the exact RMED-03 scenario. D-04 makes the error message name the scenario explicitly so users understand why the tool refuses. The "open a standalone terminal" instruction is the fix.
- **The JSONL header+footer pair (D-12) is the crash-detection signal Phase 9 needs.** Header present + footer absent = "a bust started and never finished" → Phase 9 prints a `partial bust detected` warning and asks the user to confirm restore. This is more useful than counting ops or comparing against `planned_ops` because it is a binary signal.
- **Content hashes in the manifest (D-11) enable tamper detection.** Phase 9 can see `content_sha256` on an archive op and compare against the file's current bytes before moving it back. If the user edited the archived file in-place between bust and restore, Phase 9 warns instead of blindly restoring.
- **Hybrid failure policy (D-14) is the most important reliability call.** `~/.claude.json` is transactional (one JSON blob, one atomic write) so it must be all-or-nothing. Individual filesystem ops are independent (one broken file ≠ all broken files) so continue-on-error is safe and user-friendly.
- **The extraction in D-18 (atomic-write.ts) is intentionally a refactor, not a rewrite.** Phase 7's tests must pass unchanged. The sole purpose is so the Disable MCP step and the checkpoint writer share one code path, and future users of the atomic pattern (v2+) have a clean API.
- **Amending REQUIREMENTS.md RMED-02 is part of this phase's deliverables.** The "checkpoint is recent" wording needs to go — planning must include a task to update REQUIREMENTS.md and add a note that gate #3 was dropped per PROJECT.md Key Decision alignment.

</specifics>

<deferred>
## Deferred Ideas

Ideas that came up during discussion but belong elsewhere. Captured so they are not lost.

- **Windows EPERM exponential-backoff schedule** — Success Criterion 9 requires this, but the exact retry count / initial delay / max delay / total timeout should be determined by the `gsd-phase-researcher` step, not locked in discussion. Research references: ccusage, `fs-extra`, Node core issue tracker, `graceful-fs`.
- **Output mode applicability matrix for `--dangerously-bust-ghosts`** — does `--json` work? `--quiet`? `--csv`? `--ci`? Each needs an explicit honor-or-reject answer from the planner. Not blocking Phase 8 plan creation, but must be resolved before implementation.
- **Canonical exit code ladder table in README** — 0 clean / 1 op failures / 2 checkpoint write failure / 3 running-process preflight / 4 non-TTY without bypass. Documentation task for the planner.
- **Progress-rendering UX during bust execution** (TUI progress bars per handoff §152-155 vs simple log lines) — Claude's discretion during planning; prefer simplest approach that works under `--quiet` and `--no-color`.
- **`--target <category>` / `--only agents` power-user flag** — select which categories to bust in isolation. Rejected for v1.2 scope; possibly v2. Add to backlog.
- **Pre-bust tarball backup of entire `~/.claude/` directory** — rejected. The archive + JSONL manifest pattern is already reversible and a tarball bloats disk for no additional safety benefit.
- **Multi-bust restore UX** (`ccaudit restore --from bust-2026-04-01` to pick a specific historical bust) — Phase 9 scope. The `~/.claude/ccaudit/manifests/` directory per D-10 already supports this; Phase 9 just needs the flag.
- **`ccaudit bust --undo-last` as an alias for `ccaudit restore`** — rejected; Phase 9 uses `restore` as the canonical verb.
- **Tamper-detection behavior on restore** (warn-and-proceed vs refuse vs interactive-prompt) — Phase 9 scope.
- **`--yes` / `-y` short flag in addition to `--yes-proceed-busting`** — rejected per D-16 rationale (short flags risk accidental use).

</deferred>

---

*Phase: 08-remediation-core*
*Context gathered: 2026-04-05*

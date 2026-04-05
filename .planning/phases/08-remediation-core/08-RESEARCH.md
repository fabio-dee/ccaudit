# Phase 8: Remediation Core - Research

**Researched:** 2026-04-05
**Domain:** Destructive-but-reversible CLI remediation — ghost archival, in-place JSON key-rename, YAML frontmatter patching, incremental JSONL restore manifest, cross-platform safety gates (running-process detection, Windows EPERM retry, atomic writes)
**Confidence:** HIGH

## Summary

Phase 8 ships `ccaudit --dangerously-bust-ghosts`, the destructive remediation command. The bulk of the architecture is frozen by `08-CONTEXT.md` (D-01 through D-18) and upstream Phase 7 contracts (hash format, checkpoint schema, atomic write pattern). Research scope is narrow: validate the deferred items so the planner can write tasks without further investigation.

Every deferred item has been resolved with HIGH-confidence evidence (empirical tests on the researcher's macOS machine, authoritative npm source code, and Node 22 core API verification). The phase can be planned immediately with no open questions.

**Primary recommendation:** Follow CONTEXT.md verbatim; implement the Windows EPERM retry using graceful-fs's proven schedule (60s total / 10ms-increment backoff capped at 100ms, stat-before-retry); match Claude Code processes against the conservative anchored regex `/^\s*(\d+)\s+(claude(?:\.exe)?|Claude Code|Claude)\s*$/m` on `ps -A -o pid=,comm=` / `tasklist /FO CSV /NH` output; layer 5 new modules under `packages/internal/src/remediation/` and 1 extraction; honor `--json` / `--quiet` / `--csv` / `--ci` on the bust command with the explicit matrix below.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

**Safety gates (RMED-02, RMED-03):**
- **D-01:** Two-gate checkpoint verification, not three. Gate #1: checkpoint file exists at `~/.claude/ccaudit/.last-dry-run`. Gate #2: `computeGhostHash(enriched)` on the current inventory equals `checkpoint.ghost_hash`. The "checkpoint is recent" gate #3 from RMED-02 is **dropped** — conflicts with PROJECT.md Key Decision and Phase 7 D-15. `REQUIREMENTS.md` RMED-02 needs a clarifying amendment during planning.
- **D-02:** Running-process detection via `ps -A -o comm=` on Unix, `tasklist /FO CSV /NH` on Windows. Parse output, filter for a conservative pattern matching Claude Code binary name. Exclude our own pid + parent-chain ancestors for the generic check (D-04 is the self-invocation subcase). Zero runtime deps — uses `node:child_process.spawn` only. Fallback on spawn failure: refuse with "could not verify Claude Code is stopped".
- **D-03:** On positive detection: refuse, exit 3, no bypass flag. Refusal message prints pids + binary paths. No override — this gate protects OAuth tokens.
- **D-04:** Self-invocation sub-case has a tailored message. If any detected pid is in ccaudit's own parent-process chain, the error reads: "You appear to be running ccaudit from inside a Claude Code session (parent pid: N). Open a standalone terminal and run this command there." Same exit code (3), same no-bypass policy.

**Archive & key-rename collisions (RMED-04, RMED-05, RMED-06):**
- **D-05:** Archive filename collisions resolved by ISO timestamp suffix with colons → dashes for filesystem safety: `_archived/code-reviewer.2026-04-05T18-30-00Z.md`. Same policy for skills. Archive directories created with `fs.mkdir(..., { recursive: true, mode: 0o700 })`.
- **D-06:** MCP `ccaudit-disabled:<name>` key collisions resolved by ISO timestamp suffix on the key. First bust: `mcpServers.playwright → ccaudit-disabled:playwright`. On collision: `ccaudit-disabled:playwright:2026-04-05T18-30-00Z`.
- **D-07:** Memory re-flag is an idempotent timestamp refresh, not a skip. When a memory file already carries `ccaudit-stale: true`, the current bust updates `ccaudit-flagged: <now>`. The `ccaudit-stale: true` key stays as-is. Manifest records a `refresh` op type distinct from `flag`.
- **D-08:** Hand-rolled YAML frontmatter patcher, zero external dep. Read → scan for `---\n...\n---` block → if present, update/inject ccaudit keys line-based; if absent, prepend fresh block. Malformed/exotic frontmatter (nested, multi-line strings, folded scalars, arrays beyond simple top-level) detected and skipped with verbose warning; manifest records a `skipped` op.

**Restore manifest (Phase 9 contract) (RMED-08):**
- **D-09:** JSONL format, one op per line, `fs.open(path, 'a')` + `fd.write(line + '\n')` + `fd.sync()` per op. File descriptor opened once at bust start, closed once at bust end.
- **D-10:** Per-bust timestamped file at `~/.claude/ccaudit/manifests/bust-<ISO>.jsonl`. Directory `mkdir({ recursive: true, mode: 0o700 })`. File permissions `0o600`. Colons in timestamp replaced with dashes.
- **D-11:** Full per-op schema with content hashes. Every line is `{ op_id: <uuidv4>, op_type, timestamp, status, error? }` plus per-type fields. Archive carries `content_sha256` of original bytes; disable carries `original_value` (full JSON subtree); flag carries `had_frontmatter`, `had_ccaudit_stale`, `patched_keys`, `original_content_sha256`; refresh carries `previous_flagged_at`; skipped carries `reason`.
- **D-12:** Header record (line 1, written before first op, fsynced) + footer record (last line, only on success). Phase 9 detection rule: header + footer = clean bust; header + no footer = crashed mid-bust (warn + partial restore); header missing = corrupt manifest (refuse).

**Operation execution & confirmation (RMED-09, RMED-10):**
- **D-13:** Execution order: Archive agents → Archive skills → Disable MCP → Flag memory. Filesystem-only ops first, then `~/.claude.json` mutation behind the running-process gate, then additive frontmatter patch.
- **D-14:** Hybrid failure policy. Independent fs ops (archive, flag, refresh) = continue-on-error with per-op manifest line. `~/.claude.json` mutation (Disable MCP) = fail-fast, transactional (all renames commit or none). Final exit code: 0 if all clean, 1 if any op failed.
- **D-15:** Two-prompt confirmation ceremony. `[1/2] Proceed busting? [y/N]` → `[2/2] Type exactly: proceed busting`. Trim + case-sensitive exact match, 3 retries on typo, then abort with exit 0. Above prompts, `renderChangePlan(plan)` is displayed verbatim.
- **D-16:** `--yes-proceed-busting` is the non-TTY / power-user bypass flag. Deliberately unwieldy. Valid in both TTY and non-TTY contexts. When present, both prompts from D-15 and the plan display are skipped entirely.
- **D-17:** Non-TTY behavior: refuse with exit 4 unless `--yes-proceed-busting` is present. Detect via `process.stdin.isTTY`.

**Atomic write pattern (RMED-09):**
- **D-18:** Reuse the Phase 7 D-19 atomic write pattern unchanged, extract to a shared helper at `packages/internal/src/remediation/atomic-write.ts` exporting `atomicWriteJson(path, value)`. Phase 7 regression tests must still pass.

### Claude's Discretion

The following choices are deferred to the researcher and planner:

- **Windows EPERM retry schedule** (Success Criterion 9): exact retry count, initial backoff, max backoff, total timeout. Applies to archive renames (D-05), atomic-write renames (D-18), manifest-file renames if any.
- **Output mode applicability matrix for bust**: does `--json` produce a structured bust report? Does `--quiet` suppress progress log lines? Does `--ci` imply `--yes-proceed-busting`? Does `--verbose` log per-op detail to stderr?
- **Exit code ladder consolidation**: 0 / 1 / 2 / 3 / 4 — add a canonical table to README / `docs/JSON-SCHEMA.md`.
- **Progress rendering during bust**: TUI progress bars vs simple log lines vs nothing. Prefer simplest thing that works under `--quiet` and `--no-color`.
- **Exact stderr wording** for D-03, D-04, D-17 refusal messages.
- **Module layout inside `packages/internal/src/remediation/`**. Recommendation: `bust.ts` (orchestrator), `manifest.ts`, `processes.ts`, `frontmatter.ts`, `atomic-write.ts`, `collisions.ts`.
- **UUID generation for `op_id`**: `crypto.randomUUID()` is zero-dep and sufficient.
- **Fixture strategy for Windows CI**: tmpdir + mocked output for cross-platform, plus one integration test on `windows-latest` that exercises EPERM retry.

### Deferred Ideas (OUT OF SCOPE)

- **`--target <category>` / `--only agents` power-user flag** — rejected for v1.2 scope; possibly v2.
- **Pre-bust tarball backup of entire `~/.claude/` directory** — rejected. Archive + JSONL manifest is already reversible.
- **Multi-bust restore UX (`ccaudit restore --from bust-2026-04-01`)** — Phase 9 scope. Per-bust manifest directory already supports this.
- **`ccaudit bust --undo-last` as alias for `ccaudit restore`** — rejected; Phase 9 uses `restore` as canonical verb.
- **Tamper-detection behavior on restore** — Phase 9 scope.
- **`--yes` / `-y` short flag in addition to `--yes-proceed-busting`** — rejected per D-16 rationale.

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RMED-01 | `ccaudit --dangerously-bust-ghosts` is the remediation command; the flag name is the viral UX asset | Existing gunshi boolean flag pattern (D-15/D-16 flag names confirmed; toKebab:true already at command level per Phase 7 gap fix) |
| RMED-02 | Checkpoint gate before destructive action | Phase 7's `readCheckpoint()` + `computeGhostHash()` reused verbatim; Gate #3 "recent" dropped per D-01 (amendment task required) |
| RMED-03 | Hard preflight: running Claude Code detection refuses `~/.claude.json` mutation | Empirically validated: `ps -A -o comm=` outputs literal `claude` (lowercase) for Claude Code CLI sessions on macOS; `process.ppid` + `ps -o ppid= -p <pid>` walks parent chain |
| RMED-04 | Agents archived to `_archived/` (global + project) | Scanner preserves full `filePath` + `mtimeMs` per agent; nested subdirs exist in real inventories (`agents/design/foo.md`) — **archive path MUST preserve relative structure** (see Open Question 1) |
| RMED-05 | Skills archived to `_archived/` | Same pattern as RMED-04; `resolveSkillName()` already exists for skill registration |
| RMED-06 | MCP servers disabled via key-rename in `~/.claude.json` | `readClaudeConfig()` + mutation + `atomicWriteJson()` — collision handling per D-06 |
| RMED-07 | Stale memory files flagged with `ccaudit-stale: true` frontmatter | Hand-rolled patcher (D-08) — real CLAUDE.md files mostly have NO frontmatter; fixture set defined below |
| RMED-08 | Incremental restore manifest written as ops complete | `fs.open('a')` + `fd.write` + `fd.sync()` per op confirmed working on macOS Node 22.20.0 |
| RMED-09 | Atomic write for all `~/.claude.json` mutations | Extracted `atomicWriteJson()` helper (D-18); Phase 7's pattern + Windows EPERM retry layer |
| RMED-10 | Confirmation UX | Two-prompt ceremony per D-15/D-16; `process.stdin.isTTY` gate per D-17 |

</phase_requirements>

## Standard Stack

### Core (all already in project — no new packages)

| Primitive | Source | Purpose | Why Standard |
|-----------|--------|---------|--------------|
| `node:crypto.randomUUID()` | Node 22.x built-in | Generate `op_id` for JSONL manifest | Zero-dep, empirically verified on Node 22.20.0 |
| `node:crypto.createHash('sha256')` | Node built-in | Content hashes for archive ops + re-use of Phase 7 `computeGhostHash` | Already used in `checkpoint.ts` |
| `node:fs/promises.open(path, 'a')` + `fd.write` + `fd.sync()` | Node built-in | JSONL manifest append with durability | Append mode + fsync gives crash-resilient incremental writes; verified empirically (test below) |
| `node:fs/promises.writeFile` + `rename` | Node built-in | Atomic config mutation | Phase 7 D-19 pattern, extracted per D-18 |
| `node:child_process.spawn` | Node built-in | `ps` / `tasklist` invocation | Zero-dep, CONTEXT.md D-02 mandates this over third-party process libs |
| `node:os.homedir()` | Node built-in | Resolve `~/.claude/` | Already used throughout scanners |
| `node:readline.createInterface` | Node built-in | Interactive two-prompt confirmation (D-15) | Native, no `inquirer` needed — the two prompts are trivial y/N + line read |

### Already-available project internals

| Module | Path | Reuse For |
|--------|------|-----------|
| `computeGhostHash(enriched, statFn?)` | `packages/internal/src/remediation/checkpoint.ts` | Gate #2 hash verification |
| `readCheckpoint(targetPath)` | same | Gate #1 checkpoint existence + schema validation |
| `resolveCheckpointPath()` | same | `~/.claude/ccaudit/.last-dry-run` |
| `buildChangePlan(enriched)` | `packages/internal/src/remediation/change-plan.ts` | Re-computed from fresh scan for execution |
| `calculateDryRunSavings(plan)` | `packages/internal/src/remediation/savings.ts` | Post-bust summary |
| `scanAll()` + `enrichScanResults()` | `packages/internal/src/scanner/` + `token/` | Fresh scan at bust time |
| `readClaudeConfig(configPath?)` + `ClaudeConfig` type | `packages/internal/src/scanner/scan-mcp.ts` | Read `~/.claude.json` for Disable MCP mutation |
| `renderChangePlan(plan)` | `packages/terminal/src/tables/change-plan.ts` | Display above D-15 prompts |
| `outputArgs` + `resolveOutputMode()` + `buildJsonEnvelope()` | `apps/ccaudit/src/cli/_shared-args.ts` + `_output-mode.ts` | Output mode handling per Phase 6 |
| `CCAUDIT_VERSION` | `apps/ccaudit/src/_version.ts` (build-time injected) | Manifest header record |

### Alternatives Considered

| Instead of | Could Use | Rejected Because |
|------------|-----------|------------------|
| Hand-rolled YAML patcher (D-08) | `js-yaml` / `yaml` npm | Zero-runtime-deps invariant — CLAUDE.md hard constraint; memory files have simple structures (see fixture analysis below) |
| `fs.open('a') + fd.sync` per op | Buffered in-memory array, write at end | D-09 mandates per-op flush for SIGKILL survivability — a buffered approach would lose ops on crash |
| `inquirer` / `prompts` / `enquirer` for D-15 | `node:readline` | Zero runtime deps; two trivial prompts don't justify a prompt library |
| `execa` / `cross-spawn` for `ps`/`tasklist` | `node:child_process.spawn` | Zero runtime deps; Node 22 `spawn` handles Windows path quoting adequately for the fixed-argument `tasklist /FO CSV /NH` and `ps -A -o comm=` calls |
| `fs-extra` / `graceful-fs` for EPERM retry | Hand-implement graceful-fs's retry loop inline | Zero runtime deps; the retry logic is ~20 lines and the pattern is stable (unchanged in graceful-fs since v4.1) |
| `write-file-atomic` for atomic writes | In-house `atomicWriteJson` (D-18) | Already extracting the Phase 7 pattern; adding the EPERM retry on top gives us one unified helper |

**Installation:** None. Zero new dependencies. All primitives are Node 22 built-ins or existing project internals.

**Version verification:** No new packages. `Node >= 20.0.0` already enforced via `engines` field (Phase 1 decision). Node 22.20.0 verified locally; all primitives used (`crypto.randomUUID`, `fs.open('a')`, `fs/promises`, `child_process.spawn`) are stable in 20.x and 22.x.

## Architecture Patterns

### Recommended Module Layout

```
packages/internal/src/remediation/
├── change-plan.ts        # (EXISTING, Phase 7)
├── savings.ts            # (EXISTING, Phase 7)
├── checkpoint.ts         # (EXISTING, Phase 7 — extracts atomic write to atomic-write.ts per D-18)
├── atomic-write.ts       # NEW — extracted from checkpoint.ts + EPERM retry layer
├── collisions.ts         # NEW — ISO-timestamp suffix helpers (path-safe + JSON-key-safe)
├── processes.ts          # NEW — ps/tasklist scan + parent-pid chain walk
├── frontmatter.ts        # NEW — hand-rolled YAML patcher (scan / patch / prepend / detect-malformed)
├── manifest.ts           # NEW — JSONL append helpers, header/footer builders, schema types
├── bust.ts               # NEW — orchestrator: verify → preflight → confirm → execute → summary
└── index.ts              # (EXISTING — add barrel exports for new modules)

apps/ccaudit/src/cli/commands/
└── ghost.ts              # (EXISTING — add --dangerously-bust-ghosts branch alongside --dry-run)

apps/ccaudit/src/cli/
└── _shared-args.ts       # (EXISTING — add `dangerously-bust-ghosts` + `yes-proceed-busting` flags OR add on ghost command directly; planner's call)
```

### Pattern 1: Atomic Write with Windows EPERM Retry (D-18 + SC-9)

**What:** Extract Phase 7's `writeCheckpoint` tmp+rename pattern to a shared helper and add a retry layer around the `fs.rename` call to handle Windows EPERM (Defender / Search Indexer race).

**When to use:** All `~/.claude.json` mutations + `~/.claude/ccaudit/manifests/bust-*.jsonl` if ever renamed (typically not — append-only) + the Phase 7 checkpoint writer (regression-tested unchanged).

**API signature (recommended):**

```typescript
// packages/internal/src/remediation/atomic-write.ts
export interface AtomicWriteOptions {
  mode?: number;          // default 0o600
  dirMode?: number;       // default 0o700
  // Retry schedule (Windows EPERM only — Unix throws on first attempt)
  retryTotalMs?: number;  // default 10_000 (10s — CLI-appropriate, not graceful-fs's 60s)
  retryInitialMs?: number; // default 10
  retryMaxMs?: number;    // default 100
}

export async function atomicWriteJson<T>(
  targetPath: string,
  value: T,
  options?: AtomicWriteOptions,
): Promise<void>;

// Lower-level helper exposed for manifest-file rename edge cases
export async function renameWithRetry(
  from: string,
  to: string,
  options?: Pick<AtomicWriteOptions, 'retryTotalMs' | 'retryInitialMs' | 'retryMaxMs'>,
): Promise<void>;
```

**Example (verified against graceful-fs polyfills.js):**

```typescript
// Source: https://github.com/isaacs/node-graceful-fs/blob/main/polyfills.js (rename retry pattern)
// Adapted: CLI-appropriate 10s total (graceful-fs uses 60s; we refuse to hang a user for a minute)
async function renameWithRetry(
  from: string,
  to: string,
  opts: Required<Pick<AtomicWriteOptions, 'retryTotalMs' | 'retryInitialMs' | 'retryMaxMs'>>,
): Promise<void> {
  const start = Date.now();
  let backoff = opts.retryInitialMs;
  while (true) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Unix throws and we propagate. Windows antivirus holds brief file locks.
      const retryable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      const elapsed = Date.now() - start;
      if (!retryable || elapsed >= opts.retryTotalMs || process.platform !== 'win32') {
        throw err;
      }
      // graceful-fs's stat-before-retry: verify the destination does NOT exist
      // before retrying the rename. If it does, the error was real — propagate.
      try {
        await stat(to);
        // Destination exists — original error is real, not a transient lock
        throw err;
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
        // ENOENT confirms the rename didn't happen — safe to retry
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff + 10, opts.retryMaxMs);
    }
  }
}
```

### Pattern 2: Conservative Process Detection (D-02 + D-04)

**What:** Spawn `ps -A -o pid=,comm=` on Unix / `tasklist /FO CSV /NH` on Windows, parse output, match Claude Code binary names with a **conservative anchored regex**, exclude self + parent-chain pids.

**Empirical evidence (macOS, this researcher's machine):**
- `ps -A -o pid=,comm=` output format: `  39193 claude`
- Claude Code CLI binary: `/Users/helldrik/.local/bin/claude` → symlinks to `/Users/helldrik/.local/share/claude/versions/2.1.92` (Mach-O arm64). `ps comm=` prints the **basename only** (literal `claude`, lowercase).
- `/Applications/Claude.app/Contents/MacOS/Claude` — the desktop app, shows as `Claude` (capital C, basename).
- `/Applications/ClaudeBar.app/Contents/MacOS/ClaudeBar` — a third-party ccusage monitor app. **Must NOT match** — conservative regex excludes this.

**Recommended match pattern:**

```typescript
// Source: empirical ps output on macOS + /Applications/ manual inspection
// Matches:  "  39193 claude" (Claude Code CLI)
//           "  12345 Claude"  (Claude.app desktop process, if running)
//           "  12345 Claude Code"  (potential future binary name on Win)
//           "  12345 claude.exe" (Windows executable)
// Does NOT match: ClaudeBar, ClaudeHelper, claude-code-router, etc.
const CLAUDE_PROCESS_REGEX =
  /^\s*(\d+)\s+(claude(?:\.exe)?|Claude|Claude Code|Claude\.exe)\s*$/;

// Unix: ps -A -o pid=,comm=   (no header line when trailing `=`)
// Windows: tasklist /FO CSV /NH   (CSV, no header; first field quoted image name)
```

**Windows `tasklist` output format** (for planner reference — not empirically verified in this research session, but documented in Microsoft docs):

```
"claude.exe","1234","Console","1","45,000 K"
"Claude.exe","5678","Console","1","123,000 K"
```

Parser needs to split the CSV, strip quotes on field [0], match against regex.

**Parent-chain walk** (empirical, macOS):

```typescript
// Source: empirical test on researcher's machine, confirmed process.ppid works
// From inside Claude Code's Bash tool:
//   process.pid = 62382 (node process)
//   process.ppid = 62380 (Bash shell)
//   grandparent = 60765 (claude)  <-- match against CLAUDE_PROCESS_REGEX
async function walkParentChain(startPid: number, max = 16): Promise<number[]> {
  const chain: number[] = [];
  let pid = startPid;
  for (let i = 0; i < max && pid > 0 && pid !== 1; i++) {
    const parent = await getParentPid(pid); // spawn `ps -o ppid= -p <pid>` / Windows equivalent
    if (!parent || parent === pid) break;
    chain.push(parent);
    pid = parent;
  }
  return chain;
}
// D-04 logic: if any detected Claude pid is in chain, print self-invocation message.
```

**Fallback (spawn failure):** per D-02, if `ps` / `tasklist` fails to spawn or times out (recommend 2s timeout), refuse with "could not verify Claude Code is stopped — run from a clean shell" and exit 3.

### Pattern 3: JSONL Manifest with fsync Durability (D-09 through D-12)

**What:** Open manifest file once at bust start, append one JSON object per line, `fd.sync()` after each append, close at bust end (success or failure).

**Verified empirically (macOS, Node 22.20.0):**

```typescript
const fd = await fs.open(file, 'a');
try {
  await fd.write(JSON.stringify({op: 'archive', id: 1}) + '\n');
  await fd.sync();  // flushes file data AND metadata to platform fsync
  await fd.write(JSON.stringify({op: 'archive', id: 2}) + '\n');
  await fd.sync();
} finally {
  await fd.close();
}
// Result: 2 lines, trailing newline, readable by Phase 9
```

**Durability notes:**
- **macOS (APFS):** `fsync()` → `fcntl(F_FULLFSYNC)` is recommended but expensive; Node's `fd.sync()` uses plain `fsync()` which APFS may queue. **Accepted tradeoff** — the crash-survival guarantee is "at most one truncated last line", which a plain `fsync()` satisfies for our needs.
- **Linux (ext4):** `fsync()` is durable. Default data=ordered journaling guarantees append ordering.
- **Windows (NTFS):** `fsync()` → `FlushFileBuffers()`. Durable but slow — each `fd.sync()` can add 1-10ms. With 100+ ops, this is 100ms-1s of syscall overhead — **acceptable** for a one-shot destructive operation.
- **Phase 9 reader MUST tolerate a trailing truncated line** — per D-09, this is the crash-survival contract. Parse one line at a time; skip the final line silently if it's not valid JSON.

### Pattern 4: Hand-Rolled YAML Frontmatter Patcher (D-08)

**What:** Line-based patcher that handles three cases for memory files (`CLAUDE.md` + `rules/*.md`):

1. **No frontmatter** (most common per empirical sampling) — prepend fresh block
2. **Simple frontmatter** (flat `key: value` lines) — update or inject ccaudit keys inline
3. **Malformed/exotic frontmatter** (folded scalars `|` / `>`, nested keys, multi-line arrays) — skip with manifest `skipped` op

**Empirical evidence from real memory files:**

- `~/.claude/CLAUDE.md` — NO frontmatter (starts with `# SuperClaude Entry Point`)
- `~/gitRepos/*/CLAUDE.md` sampled 10 files — **NONE had frontmatter** (all start with `# CLAUDE.md` heading)
- Real frontmatter that exists in the broader `.claude/` tree is on **agent/skill** files, NOT memory files (agents have complex YAML with nested keys, tools arrays, folded scalars; but those are not scanned as "memory" — the memory scanner is `CLAUDE.md` + `rules/*.md` only)
- `projects/*/memory/*.md` files (observed on researcher's machine) have simple flat frontmatter: `name:`, `description:`, `type:` — but these files are also NOT in the memory scanner scope (scanner looks at `~/.claude/CLAUDE.md`, `~/.claude/rules/`, `<project>/CLAUDE.md`, `<project>/.claude/rules/`)

**Conclusion:** The overwhelming real-world case is case #1 (no frontmatter, prepend). Case #2 (flat key:value) is the secondary case. Case #3 (malformed) is rare but must be detected and skipped for safety.

**Recommended patcher algorithm:**

```typescript
// packages/internal/src/remediation/frontmatter.ts
import { readFile, writeFile } from 'node:fs/promises';

export type FrontmatterPatchResult =
  | { status: 'patched'; hadFrontmatter: boolean; hadCcauditStale: boolean; previousFlaggedAt: string | null }
  | { status: 'refreshed'; previousFlaggedAt: string }  // idempotent re-flag per D-07
  | { status: 'skipped'; reason: 'exotic-yaml' | 'binary' | 'read-error' };

export async function patchFrontmatter(
  filePath: string,
  nowIso: string,
): Promise<FrontmatterPatchResult> {
  // 1. Read file bytes (reject if not UTF-8 parseable)
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return { status: 'skipped', reason: 'read-error' };
  }

  // 2. Detect and normalize line endings (preserve on write)
  const crlf = /\r\n/.test(raw);
  const eol = crlf ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);

  // 3. Detect frontmatter block:
  //    Must start with '---' on line 0 (no leading whitespace), followed by
  //    content, ending with '---' on a later line.
  const hasFrontmatter = lines[0] === '---';
  if (!hasFrontmatter) {
    // CASE 1: Prepend fresh frontmatter block
    const newBlock = [
      '---',
      'ccaudit-stale: true',
      `ccaudit-flagged: ${nowIso}`,
      '---',
      '',  // blank line after closing fence
    ].join(eol);
    await writeFile(filePath, newBlock + eol + raw, 'utf8');
    return { status: 'patched', hadFrontmatter: false, hadCcauditStale: false, previousFlaggedAt: null };
  }

  // Find closing '---'
  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { closingIdx = i; break; }
  }
  if (closingIdx === -1) {
    return { status: 'skipped', reason: 'exotic-yaml' };  // unterminated block
  }

  // 4. Walk frontmatter body (lines 1 to closingIdx-1) and validate as FLAT key:value
  //    Any line that is NOT a simple `key: value` (ignoring blank lines and
  //    comments) triggers the skip-with-reason path.
  const bodyLines = lines.slice(1, closingIdx);
  const EXOTIC_PATTERNS = [
    /^\s+\S/,               // indented line (nested key or array item)
    /^[^:]+:\s*[|>][+-]?\s*$/,  // folded/literal scalar markers
    /^\s*-\s/,              // array item
  ];
  let ccauditStaleIdx = -1;
  let ccauditFlaggedIdx = -1;
  let previousFlaggedAt: string | null = null;
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    // Must match simple key: value
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      // Check if it looks exotic
      if (EXOTIC_PATTERNS.some((p) => p.test(line))) {
        return { status: 'skipped', reason: 'exotic-yaml' };
      }
      return { status: 'skipped', reason: 'exotic-yaml' };
    }
    if (kv[1] === 'ccaudit-stale') ccauditStaleIdx = i + 1; // offset by 1 for the opening ---
    if (kv[1] === 'ccaudit-flagged') {
      ccauditFlaggedIdx = i + 1;
      // Parse previous timestamp (quoted or bare)
      previousFlaggedAt = kv[2].replace(/^["']|["']$/g, '').trim();
    }
  }

  // 5. Apply patch — update existing keys in place OR inject before closing fence
  const newLines = [...lines];
  if (ccauditStaleIdx >= 0 && ccauditFlaggedIdx >= 0) {
    // D-07: idempotent refresh — update flagged timestamp, preserve stale flag
    newLines[ccauditFlaggedIdx] = `ccaudit-flagged: ${nowIso}`;
    await writeFile(filePath, newLines.join(eol), 'utf8');
    return { status: 'refreshed', previousFlaggedAt: previousFlaggedAt ?? 'unknown' };
  }

  // Inject both keys before the closing '---' fence
  const inject = [
    ...(ccauditStaleIdx < 0 ? ['ccaudit-stale: true'] : []),
    ...(ccauditFlaggedIdx < 0 ? [`ccaudit-flagged: ${nowIso}`] : []),
  ];
  newLines.splice(closingIdx, 0, ...inject);
  await writeFile(filePath, newLines.join(eol), 'utf8');
  return {
    status: 'patched',
    hadFrontmatter: true,
    hadCcauditStale: ccauditStaleIdx >= 0,
    previousFlaggedAt,
  };
}
```

**Required fixture set** (planner MUST create these):

| Fixture | Content | Expected Result |
|---------|---------|-----------------|
| `01-no-frontmatter.md` | Plain `# Heading\nBody` | `status: 'patched'`, `hadFrontmatter: false` |
| `02-empty-frontmatter.md` | `---\n---\n\nBody` | `status: 'patched'`, `hadFrontmatter: true` |
| `03-unrelated-keys.md` | `---\ntitle: X\nauthor: Y\n---\n\nBody` | `status: 'patched'`, both ccaudit keys injected |
| `04-has-ccaudit-stale.md` | `---\ntitle: X\nccaudit-stale: true\nccaudit-flagged: 2026-01-01T00:00:00Z\n---\n` | `status: 'refreshed'`, `previousFlaggedAt: '2026-01-01T00:00:00Z'` |
| `05-exotic-folded.md` | `---\ndescription: >\n  Multi-line folded\n  scalar content\n---` | `status: 'skipped'`, `reason: 'exotic-yaml'` |
| `06-exotic-array.md` | `---\ntools:\n  - Read\n  - Write\n---` | `status: 'skipped'`, `reason: 'exotic-yaml'` |
| `07-exotic-nested.md` | `---\nconfig:\n  nested: true\n---` | `status: 'skipped'`, `reason: 'exotic-yaml'` |
| `08-crlf-line-endings.md` | Same as `01` but with `\r\n` | `status: 'patched'`, output preserves CRLF |
| `09-unterminated-frontmatter.md` | `---\nkey: value\n\n# Body (no closing fence)` | `status: 'skipped'`, `reason: 'exotic-yaml'` |
| `10-empty-file.md` | Empty bytes | `status: 'patched'`, `hadFrontmatter: false` (edge case) |

**BOM handling:** Recommend stripping a leading `\uFEFF` before the `---` check (real-world markdown editors occasionally emit BOM). If BOM is present + no frontmatter, the prepend case MUST re-emit without BOM (or preserve it — planner's call; recommend stripping).

### Pattern 5: ISO-Timestamp Collision Suffix (D-05, D-06, D-10)

**What:** When an archived filename, JSON key, or manifest filename collides, suffix with `new Date().toISOString().replace(/:/g, '-')`.

**Empirically verified (APFS, macOS):**

```
Test filename: test.2026-04-05T10-26-03.544Z.md
Created OK, size= 5
```

**Cross-filesystem safety:**

| Filesystem | Colon allowed? | Dash allowed? | `T` / `Z` / `.` allowed? | Verdict |
|------------|----------------|---------------|--------------------------|---------|
| APFS (macOS) | YES | YES | YES | Safe |
| ext4 (Linux) | YES | YES | YES | Safe (only `/` + NUL banned) |
| NTFS (Windows) | NO (reserved for ADS streams) | YES | YES | Dash-replacement **MANDATORY** |
| FAT32 / exFAT | NO | YES | YES | Dash-replacement mandatory |

**JSON key safety:** The ccaudit-disabled:name:timestamp key contains literal colons **inside the JSON key string**. Per RFC 8259, JSON object keys are arbitrary Unicode strings — colons are fine. The suffix is only cosmetically similar to the colons in the ISO timestamp. **Use UNDASHED colons in the JSON key** (not in filenames). Example:

```json
{
  "ccaudit-disabled:playwright:2026-04-05T18:30:00Z": { ... }
}
```

**Filename form** (dashes):
```
~/.claude/agents/_archived/code-reviewer.2026-04-05T18-30-00Z.md
```

**Helper API:**

```typescript
// packages/internal/src/remediation/collisions.ts
export function timestampSuffixForFilename(date = new Date()): string {
  // YYYY-MM-DDTHH-MM-SSZ (no milliseconds, dashes for cross-FS safety)
  return date.toISOString().replace(/\.\d{3}/, '').replace(/:/g, '-');
}

export function timestampSuffixForJsonKey(date = new Date()): string {
  // Keep colons — JSON key strings allow them (D-06)
  return date.toISOString().replace(/\.\d{3}/, '');
}

// Build collision-resistant archive path
export function buildArchivePath(
  sourcePath: string,
  archivedDir: string,
  collisionExistsSync: (p: string) => boolean,
  now?: Date,
): string;

// Build collision-resistant disabled MCP key
export function buildDisabledMcpKey(
  serverName: string,
  existingKeys: Set<string>,
  now?: Date,
): string;
```

### Pattern 6: Two-Prompt Confirmation via node:readline (D-15)

**What:** Native Node `readline` for both prompts. No external prompt library needed — both prompts are plain line-reads.

**Example (reference implementation):**

```typescript
// packages/internal/src/remediation/bust.ts or confirm.ts
import { createInterface } from 'node:readline';

export async function runConfirmationCeremony(): Promise<'accepted' | 'aborted'> {
  // Prompt 1: y/N
  const rl1 = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer1 = await new Promise<string>((resolve) => {
      rl1.question('\n[1/2] Proceed busting? [y/N]: ', resolve);
    });
    if (!/^[yY]$/.test(answer1.trim())) {
      console.log('Aborted by user.');
      return 'aborted';
    }
  } finally {
    rl1.close();
  }

  // Prompt 2: typed phrase, up to 3 retries
  for (let attempt = 1; attempt <= 3; attempt++) {
    const rl2 = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer2 = await new Promise<string>((resolve) => {
        rl2.question('\n[2/2] Type exactly: proceed busting\n> ', resolve);
      });
      if (answer2.trim() === 'proceed busting') {
        return 'accepted';
      }
      if (attempt < 3) {
        console.log('(typo — try again)');
      }
    } finally {
      rl2.close();
    }
  }
  console.log('Aborted — confirmation phrase mismatch');
  return 'aborted';
}
```

**D-17 TTY gate (pre-ceremony):**

```typescript
if (!ctx.values.yesProceedBusting) {
  if (!process.stdin.isTTY) {
    console.error(
      'ccaudit --dangerously-bust-ghosts requires an interactive terminal.\n' +
      'To run non-interactively, pass --yes-proceed-busting (only if you understand what you are doing).'
    );
    process.exitCode = 4;
    return;
  }
  // ... ceremony
}
```

### Anti-Patterns to Avoid

- **DO NOT** use `fs.writeFile` directly on `~/.claude.json` without the atomic tmp+rename helper — corrupts OAuth tokens on concurrent writes or crash mid-write.
- **DO NOT** use `fs.rename` without the EPERM retry wrapper on Windows — CI matrix will fail intermittently otherwise.
- **DO NOT** buffer manifest ops in memory and write at end — violates D-09's SIGKILL-survivability contract.
- **DO NOT** parse the ccaudit-disabled key back by splitting on `:` — the serverName itself might contain colons (rare, but valid JSON). Store `originalKey` in the manifest and look it up by `op_id`.
- **DO NOT** delete source files after a successful archive — archive is `rename` (move), not `copy + delete`. A single atomic operation.
- **DO NOT** use a prompt library (`inquirer`, `enquirer`, `prompts`, `@inquirer/*`) — zero runtime deps is a hard invariant.
- **DO NOT** use `js-yaml` / `yaml` for frontmatter — see D-08. The patcher is line-based and handles only the subset needed.
- **DO NOT** try to be clever about `~/.claude.json` mutation (streaming JSON edits, partial updates). Read the whole file, parse, mutate, serialize, atomic-write. The file is small (< 100KB in practice).
- **DO NOT** swallow ps/tasklist spawn errors and assume "no Claude running". Per D-02, fallback is refuse-with-message, not silent pass.
- **DO NOT** try to use `ps -o cmd=` (full command line) as the match source — too many false positives (shells, grep, ccaudit itself). `comm=` (basename) is the intended field.
- **DO NOT** omit `fd.sync()` between manifest writes — even though fsync is slow on Windows, the crash-resilience contract depends on it.

## Don't Hand-Roll

| Problem | Don't Build Custom | Use Instead | Why |
|---------|--------------------|-------------|-----|
| UUID generation for `op_id` | Custom random-string generator | `crypto.randomUUID()` (Node 20.x+) | Zero-dep, crypto-secure, stable UUID v4 format |
| SHA-256 content hash | Custom hash | `crypto.createHash('sha256').update(bytes).digest('hex')` | Node built-in, already used in Phase 7 |
| ISO 8601 timestamps | Manual formatting | `new Date().toISOString()` | Deterministic, spec-correct, already used in checkpoint |
| Atomic JSON write | Third-party `write-file-atomic` | Extracted `atomicWriteJson` (D-18) + EPERM retry | Zero-dep invariant; we already own the pattern |
| JSON parsing of `~/.claude.json` | Streaming JSON parser | `JSON.parse(await readFile(path, 'utf8'))` | File is small (~100KB), single-shot read is simplest + safest |
| Checkpoint hash verification | Fresh hash compute | Reuse `computeGhostHash()` from Phase 7 | Identical algorithm, tested across 11 in-source tests |
| Change plan re-build | Cached from checkpoint | Re-run `buildChangePlan(enriched)` on fresh scan | Checkpoint only stores the hash, not the plan — this is intentional per Phase 7 D-17 |
| Two-prompt confirmation | Prompt library | `node:readline.createInterface` + `rl.question` | Zero-dep; the prompts are trivial |
| Progress bars | TUI framework | Simple `console.log` lines (or none under `--quiet` / `--no-color`) | Zero-dep; simplest thing that works under all output modes |
| Process detection | `ps-list`, `find-process`, `is-running` | `child_process.spawn('ps', ['-A', '-o', 'pid=,comm='])` | Zero-dep invariant; argv is fixed (no injection surface) |
| Parent-pid chain walk | Third-party process-tree libs | Iterative `ps -o ppid= -p <pid>` spawn | Zero-dep; max depth 16 is sufficient |

**Key insight:** Node 22's built-in APIs cover every primitive Phase 8 needs. The zero-dep invariant is not just a constraint — it's a forcing function that aligns with the safety model (fewer dependencies = smaller attack surface on a tool that mutates `~/.claude.json`).

## Runtime State Inventory

Not applicable — Phase 8 is a greenfield phase adding new code. There is no rename, refactor, or migration. The Phase 7 `writeCheckpoint` extraction to `atomic-write.ts` (D-18) is an internal refactor only; the on-disk schema, file paths, and runtime behavior are unchanged. Explicitly verified:

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | None — Phase 8 writes NEW files (`~/.claude/ccaudit/manifests/bust-*.jsonl`) and NEW archive directories (`_archived/` under existing scanner paths) | None |
| Live service config | Claude Code's `~/.claude.json` is MUTATED by this phase (that's the point) — but the contract is "preserve valid JSON, key-rename only", verified against D-06 | None (this IS the feature) |
| OS-registered state | None — ccaudit is a one-shot CLI, no daemons, no Windows Task Scheduler, no launchd, no systemd | None |
| Secrets/env vars | No new secrets. `~/.claude.json` contains OAuth tokens — the running-process gate (D-02/D-03) protects these from concurrent writes | None |
| Build artifacts | `packages/internal/dist/` needs rebuild after new modules added — normal Phase 1 rebuild pattern | `pnpm -r build` at end of phase |

## Common Pitfalls

### Pitfall 1: Assuming `fs.rename` is atomic on Windows across volumes

**What goes wrong:** Windows `rename` fails with `EXDEV` if source and destination are on different volumes (e.g., `%APPDATA%` on C:, tmp file on D:).

**Why it happens:** MoveFile on Windows does not support cross-volume moves for rename semantics; only intra-volume.

**How to avoid:** The tmp file MUST be written in the **same directory** as the target, not in `os.tmpdir()`. Phase 7's `writeCheckpoint` already does this correctly (`<target>.tmp-<pid>`). Preserve this invariant in the extraction.

**Warning signs:** `EXDEV` errors in Windows CI.

### Pitfall 2: Windows antivirus locks the tmp file immediately after write

**What goes wrong:** Write to tmp → Defender scans tmp → rename fails with EPERM because Defender holds an exclusive handle.

**Why it happens:** Windows Defender scans every newly-created file. On fast CI runners, the rename can race the scan.

**How to avoid:** The `renameWithRetry` helper (Pattern 1 above) with graceful-fs-style backoff. Test explicitly on `windows-latest` per SC-9.

**Warning signs:** Intermittent CI failures with `EPERM: operation not permitted, rename`.

### Pitfall 3: `process.stdin.isTTY` is `undefined`, not `false`, in some CI environments

**What goes wrong:** `!process.stdin.isTTY` is `true` when `isTTY` is `undefined` (GitHub Actions sets it to `undefined`), which is the desired behavior — but a strict `=== false` check would incorrectly treat GitHub Actions as TTY.

**Why it happens:** Node doesn't set `isTTY` when stdin is not a TTY — the property is `undefined`.

**How to avoid:** Use `!process.stdin.isTTY` (truthy check), not `process.stdin.isTTY === false`.

**Warning signs:** CI tests passing locally but the non-TTY code path never triggering in GitHub Actions.

### Pitfall 4: `readline.question` callback never fires on EOF (piped stdin closes)

**What goes wrong:** If stdin closes (piped input exhausted), `rl.question` hangs forever.

**Why it happens:** `readline` waits for a newline; EOF is not a newline.

**How to avoid:** Use the D-17 TTY gate to refuse non-TTY input BEFORE entering the ceremony. Belt-and-suspenders: attach `rl.on('close', () => resolve('__eof__'))` inside the ceremony as a safety net and treat `__eof__` as abort.

**Warning signs:** Test hangs on `echo "" | ccaudit --dangerously-bust-ghosts`.

### Pitfall 5: JSONL manifest trailing newline races fsync

**What goes wrong:** Writing `JSON.stringify(op)` followed by a separate `fd.write('\n')` could produce a partially-flushed line if the process crashes between the two writes.

**Why it happens:** Two `fd.write` calls = two syscalls = two potential crash points.

**How to avoid:** Concatenate in one write: `fd.write(JSON.stringify(op) + '\n')`. Then `fd.sync()`. Empirically verified working on macOS (see Pattern 3).

**Warning signs:** Phase 9 reads a manifest line missing its trailing newline.

### Pitfall 6: Malformed `~/.claude.json` from prior partial bust

**What goes wrong:** A crashed bust left `~/.claude.json.tmp-12345` in place + the original is fine. But `readClaudeConfig` uses a bare try/catch return-empty pattern, which would silently hide the corruption.

**Why it happens:** Scanner uses `return {}` on parse error (silent skip pattern from Phase 3).

**How to avoid:** The bust command MUST NOT use `readClaudeConfig` silent-skip behavior — it must read `~/.claude.json` with loud errors during the Disable MCP step. If the file is corrupt, refuse the bust and exit 1 with a clear message. The Phase 3 scanner pattern is "silent read, loud write" (Phase 6 code context line 168); Phase 8 is on the loud side.

**Warning signs:** Bust succeeds but MCP servers were not actually disabled because parse failed silently.

### Pitfall 7: Archive path flattens nested agent directories

**What goes wrong:** Agents under `~/.claude/agents/design/design-ux-architect.md` get scanned with `name = 'design-ux-architect'` (basename only). Naively archiving to `_archived/design-ux-architect.md` collapses the `design/` subdirectory — losing the namespace and causing collisions with any top-level `design-ux-architect.md`.

**Why it happens:** `scanAgents()` uses `path.basename(filePath, '.md')` for the `name` field but stores the full `path` too. The archive logic must use the **full relative path** from the agents root, not the basename.

**How to avoid:** Compute archive destination as `<agentsRoot>/_archived/<relativePath>` where `relativePath = path.relative(agentsRoot, sourcePath)`. Then `mkdir -p` the intermediate directories before the rename. Same for skills.

**Warning signs:** Two agents with the same basename in different subdirs collide in `_archived/`.

### Pitfall 8: `ps -A -o comm=` truncates long command names on Linux

**What goes wrong:** Linux `ps` truncates `comm` field at 15 chars by default (kernel limit). A binary named `claude-code-cli` shows as `claude-code-cli` (15 chars) but `Claude Code CLI Helper` would show truncated.

**Why it happens:** `/proc/<pid>/comm` is limited to `TASK_COMM_LEN = 16` bytes (15 + NUL).

**How to avoid:** The empirical `claude` name is 6 chars — safely within the limit. Document that if future Claude Code CLI versions ship a longer binary name, the regex may need to widen. For robustness, add `Claude Code` to the pattern (future-proofing) and rely on `comm=` for now.

**Warning signs:** Future Claude Code versions not detected by the regex.

### Pitfall 9: `writeCheckpoint` regression from D-18 extraction

**What goes wrong:** Extracting `writeCheckpoint`'s internals to `atomic-write.ts` changes the call signature or error propagation, breaking Phase 7 tests.

**Why it happens:** Refactors are notorious for introducing subtle behavior differences.

**How to avoid:** Phase 8 D-18 explicitly mandates "Phase 7 regression tests must still pass". Add this as a task checkpoint: run `pnpm -F @ccaudit/internal test` after the extraction and confirm 100% of Phase 7's checkpoint tests pass. The extraction should be a pure code-move with `writeCheckpoint` becoming a thin wrapper that calls `atomicWriteJson`.

**Warning signs:** Phase 7 in-source tests fail after Phase 8 Plan 01.

### Pitfall 10: Windows `tasklist` CSV field quoting

**What goes wrong:** A Claude Code process on Windows shows as `"claude.exe"` (quoted) in `tasklist /FO CSV /NH` output, but the regex was written for Unix `comm=` output (unquoted).

**Why it happens:** `tasklist /FO CSV` quotes every field.

**How to avoid:** Write a platform-specific parser. On Windows, split CSV rows, strip surrounding quotes on field [0] (image name), then match against the regex. On Unix, split on whitespace, take the last field.

**Warning signs:** Windows CI tests for process detection fail.

## Code Examples

### Example 1: atomicWriteJson with EPERM retry (Pattern 1)

```typescript
// packages/internal/src/remediation/atomic-write.ts
// Source: Phase 7 checkpoint.ts extraction + graceful-fs retry pattern
// https://github.com/isaacs/node-graceful-fs/blob/main/polyfills.js
import { mkdir, writeFile, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';

export interface AtomicWriteOptions {
  mode?: number;
  dirMode?: number;
  retryTotalMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
}

const DEFAULTS: Required<AtomicWriteOptions> = {
  mode: 0o600,
  dirMode: 0o700,
  retryTotalMs: 10_000,
  retryInitialMs: 10,
  retryMaxMs: 100,
};

export async function atomicWriteJson<T>(
  targetPath: string,
  value: T,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const opts = { ...DEFAULTS, ...options };
  const dir = path.dirname(targetPath);
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

  await mkdir(dir, { recursive: true, mode: opts.dirMode });
  const body = JSON.stringify(value, null, 2);

  try {
    await writeFile(tmpPath, body, { mode: opts.mode, encoding: 'utf8' });
    await renameWithRetry(tmpPath, targetPath, opts);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* swallow */ }
    throw err;
  }
}

async function renameWithRetry(
  from: string,
  to: string,
  opts: Required<AtomicWriteOptions>,
): Promise<void> {
  const start = Date.now();
  let backoff = opts.retryInitialMs;
  while (true) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      const elapsed = Date.now() - start;
      if (!retryable || elapsed >= opts.retryTotalMs || process.platform !== 'win32') {
        throw err;
      }
      // graceful-fs pattern: verify destination does NOT exist before retry
      try {
        await stat(to);
        throw err;  // dest exists → error is real
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff + 10, opts.retryMaxMs);
    }
  }
}
```

### Example 2: Process detection (Pattern 2)

```typescript
// packages/internal/src/remediation/processes.ts
import { spawn } from 'node:child_process';

export interface ClaudeProcess {
  pid: number;
  command: string;
}

// Matches basename-only process names.
// Unix comm=: "claude", "Claude"
// Windows tasklist image: "claude.exe", "Claude.exe"
const CLAUDE_NAME_REGEX = /^(claude(?:\.exe)?|Claude(?:\.exe)?|Claude Code)$/;

export async function detectClaudeProcesses(
  selfPid: number = process.pid,
): Promise<{ status: 'ok'; processes: ClaudeProcess[] } | { status: 'spawn-failed'; error: string }> {
  try {
    const raw = process.platform === 'win32'
      ? await runCommand('tasklist', ['/FO', 'CSV', '/NH'], 2000)
      : await runCommand('ps', ['-A', '-o', 'pid=,comm='], 2000);

    const processes = process.platform === 'win32'
      ? parseTasklistCsv(raw)
      : parsePsComm(raw);

    return {
      status: 'ok',
      processes: processes.filter((p) => p.pid !== selfPid),
    };
  } catch (err) {
    return { status: 'spawn-failed', error: (err as Error).message };
  }
}

function parsePsComm(raw: string): ClaudeProcess[] {
  const out: ClaudeProcess[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: "39193 claude" or "  39193 /path/to/claude"
    const m = /^(\d+)\s+(.+)$/.exec(trimmed);
    if (!m) continue;
    const pid = Number(m[1]);
    const name = (m[2].split('/').pop() ?? '').trim();
    if (CLAUDE_NAME_REGEX.test(name)) {
      out.push({ pid, command: name });
    }
  }
  return out;
}

function parseTasklistCsv(raw: string): ClaudeProcess[] {
  const out: ClaudeProcess[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // CSV row: "image","pid","session","sessionNum","memUsage"
    const fields = line.match(/"([^"]*)"/g);
    if (!fields || fields.length < 2) continue;
    const image = fields[0].slice(1, -1);
    const pid = Number(fields[1].slice(1, -1));
    if (Number.isNaN(pid)) continue;
    if (CLAUDE_NAME_REGEX.test(image)) {
      out.push({ pid, command: image });
    }
  }
  return out;
}

async function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0 && code !== null) {
        reject(new Error(`${cmd} exited ${code}`));
        return;
      }
      resolve(out);
    });
  });
}

// Parent-chain walk for self-invocation detection (D-04)
export async function walkParentChain(startPid: number, maxDepth = 16): Promise<number[]> {
  const chain: number[] = [];
  let pid = startPid;
  for (let i = 0; i < maxDepth && pid > 1; i++) {
    const parent = await getParentPid(pid);
    if (parent === null || parent === pid) break;
    chain.push(parent);
    pid = parent;
  }
  return chain;
}

async function getParentPid(pid: number): Promise<number | null> {
  try {
    const raw = process.platform === 'win32'
      ? await runCommand('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'ParentProcessId', '/value'], 1500)
      : await runCommand('ps', ['-o', 'ppid=', '-p', String(pid)], 1500);
    if (process.platform === 'win32') {
      const m = /ParentProcessId=(\d+)/.exec(raw);
      return m ? Number(m[1]) : null;
    }
    const n = Number(raw.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
```

### Example 3: JSONL manifest writer (Pattern 3)

```typescript
// packages/internal/src/remediation/manifest.ts
import { open, type FileHandle, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const MANIFEST_VERSION = 1 as const;

export interface ManifestHeader {
  record_type: 'header';
  manifest_version: typeof MANIFEST_VERSION;
  ccaudit_version: string;
  checkpoint_ghost_hash: string;
  checkpoint_timestamp: string;
  since_window: string;
  os: 'darwin' | 'linux' | 'win32';
  node_version: string;
  planned_ops: { archive: number; disable: number; flag: number };
}

export interface ArchiveOp {
  op_id: string;
  op_type: 'archive';
  timestamp: string;
  status: 'completed' | 'failed';
  error?: string;
  category: 'agent' | 'skill';
  scope: 'global' | 'project';
  source_path: string;
  archive_path: string;
  content_sha256: string;
}

// ... DisableOp, FlagOp, RefreshOp, SkippedOp as per D-11 ...

export type ManifestOp = ArchiveOp | /* DisableOp | FlagOp | RefreshOp | SkippedOp */;

export interface ManifestFooter {
  record_type: 'footer';
  status: 'completed';
  actual_ops: {
    archive: { completed: number; failed: number };
    disable: { completed: number; failed: number };
    flag: { completed: number; failed: number; refreshed: number; skipped: number };
  };
  duration_ms: number;
  exit_code: number;
}

export function resolveManifestPath(now = new Date()): string {
  // D-10: per-bust file with ISO-dash timestamp
  const stamp = now.toISOString().replace(/\.\d{3}/, '').replace(/:/g, '-');
  return path.join(homedir(), '.claude', 'ccaudit', 'manifests', `bust-${stamp}.jsonl`);
}

export class ManifestWriter {
  private fd: FileHandle | null = null;
  private startMs = 0;

  constructor(public readonly filePath: string) {}

  async open(header: ManifestHeader): Promise<void> {
    // Ensure directory exists with 0o700
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    // Open with 'a' (append, create if absent) and 0o600 mode
    this.fd = await open(this.filePath, 'a', 0o600);
    // On POSIX, the open() mode arg is applied only when creating. chmod
    // belt-and-suspenders in case the file already existed (shouldn't, but).
    try { await chmod(this.filePath, 0o600); } catch { /* Windows: no-op */ }
    this.startMs = Date.now();
    // Write header + fsync
    await this.fd.write(JSON.stringify(header) + '\n');
    await this.fd.sync();
  }

  async writeOp(op: ManifestOp): Promise<void> {
    if (!this.fd) throw new Error('ManifestWriter not opened');
    await this.fd.write(JSON.stringify(op) + '\n');
    await this.fd.sync();
  }

  async close(footer: ManifestFooter | null): Promise<void> {
    if (!this.fd) return;
    if (footer) {
      await this.fd.write(JSON.stringify(footer) + '\n');
      await this.fd.sync();
    }
    await this.fd.close();
    this.fd = null;
  }

  // Helper factories
  buildArchiveOp(input: Omit<ArchiveOp, 'op_id' | 'timestamp' | 'status'> & { content: Buffer }): ArchiveOp {
    return {
      op_id: randomUUID(),
      op_type: 'archive',
      timestamp: new Date().toISOString(),
      status: 'completed',
      category: input.category,
      scope: input.scope,
      source_path: input.source_path,
      archive_path: input.archive_path,
      content_sha256: createHash('sha256').update(input.content).digest('hex'),
    };
  }

  get elapsedMs(): number {
    return Date.now() - this.startMs;
  }
}
```

## State of the Art

| Old Approach | Current Approach | Why Changed |
|--------------|------------------|-------------|
| Triple confirmation (`I accept full responsibility` phrase) per handoff §145-150 | Two-prompt ceremony (`proceed busting` phrase) per D-15 | Faster to type, still screenshot-friendly, lower friction for repeat users |
| Time-based checkpoint expiry (RMED-02 gate #3 "recent" wording) | Hash-only gating per D-01 + PROJECT.md Key Decision | Time-based is wrong — a 5-minute-old dry-run on a changed inventory is invalid. Hash captures the only property that matters: "did the inventory change since the preview?" |
| MCP comment-out (handoff §180-195) | Key-rename to `ccaudit-disabled:<name>` | JSON doesn't support comments. `// ccaudit-disabled` in JSON is a parse error. Key-rename preserves valid JSON. |
| Manual (shell-scripted) retry on Windows EPERM | Inline graceful-fs-style retry loop in atomic-write.ts | graceful-fs pattern has been the de-facto standard since 2013; widely used by npm/cli, fs-extra, write-file-atomic |
| External process libraries (`ps-list`, `find-process`, `ps-tree`) | `child_process.spawn('ps' / 'tasklist')` + hand-rolled parsing | Zero runtime deps invariant; argv is fixed (no injection surface); empirically verified to work |

**Deprecated/outdated:**
- **Handoff §149 phrase** `I accept full responsibility` — superseded by D-15 `proceed busting`
- **Handoff §113 rule** "checkpoint is recent (≤24h)" — superseded by D-01 (hash-only gating)
- **Handoff §192** `// ccaudit-disabled playwright` inline JSON "comment" — NEVER VALID. Superseded by key-rename per PROJECT.md Key Decision

## Open Questions

1. **Nested agent/skill archive path preservation**
   - What we know: `scanAgents` uses `path.basename(filePath, '.md')` for the `name` field but stores the full `path`. Real agent inventories have nested subdirectories (`agents/design/`, `agents/integrations/aider/`).
   - What's unclear: Does `_archived/` preserve the relative subdirectory structure, or flatten to the basename with a suffix-based collision resolver?
   - Recommendation: **Preserve relative structure.** Archive destination = `<agentsRoot>/_archived/<path.relative(agentsRoot, sourcePath)>`. Creates `_archived/design/foo.md` parallel to `design/foo.md`. This gives lossless round-trip to Phase 9 restore, prevents cross-subdirectory basename collisions, and matches how the file was organized. Planner should add a task to compute the agents root from `item.path` (walk up past `agents/` segment) and create intermediate dirs with `mkdir -p`.

2. **Windows CI EPERM retry test exercise (SC-9)**
   - What we know: SC-9 requires `windows-latest` CI and a test that exercises the EPERM retry path.
   - What's unclear: How to *reliably* trigger EPERM in CI — real Windows Defender locks are races and not reproducible on demand.
   - Recommendation: **Unit-test the retry loop in isolation with a mocked `fs.rename` that fails with EPERM N times then succeeds.** The unit test proves the retry count, the stat-before-retry gate, and the backoff schedule. Add a separate smoke test on `windows-latest` that performs a real tmp+rename round-trip (without forcing EPERM) to verify the full pipeline runs on Windows. Don't try to actually race Defender.

3. **Progress rendering during long bust operations**
   - What we know: The handoff §152-155 mockup shows TUI progress bars. CONTEXT.md defers this to planner.
   - What's unclear: Does this justify a TUI dependency?
   - Recommendation: **Simple log lines, no progress bar.** Under default mode, print `Archiving agents...` then `  ✓ 128/128 archived (3 failed, see manifest)` per category. Under `--quiet`, print nothing to stdout (all data goes to stderr via verbose log). Under `--verbose`, print one line per op to stderr. This is zero-dep, works under `--no-color` and `--ci`, and avoids a TUI dependency.

4. **`ccaudit.json` output envelope for `--json` on bust**
   - What we know: Phase 6 JSON envelope shape is frozen. Bust needs to emit a structured report.
   - What's unclear: What's in the bust payload?
   - Recommendation: **Emit `{ dryRun: false, bust: { manifestPath, counts, savings, duration_ms, failed_ops: [...] } }`** nested inside `buildJsonEnvelope('ghost', sinceStr, exitCode, {...})`. Consistent with Phase 7's `{ dryRun: true, changePlan, checkpoint }` shape.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | ✓ | 22.20.0 (researcher) / 22 (CI) | Node 20.x LTS (engines field enforces) |
| `ps` utility | Unix process detection (D-02) | ✓ | macOS 14.x / Linux coreutils / BSD | Refuse with "could not verify Claude Code is stopped" per D-02 |
| `tasklist.exe` | Windows process detection (D-02) | Assumed present | Built-in on all Windows ≥ XP | Refuse with spawn-failure message |
| `wmic` | Windows parent-pid lookup | Deprecated in Win 11 but present | ≥ Win XP; Win 11 via optional feature | Use PowerShell `Get-CimInstance Win32_Process` as fallback (planner: verify availability on Win 11 CI) |
| `crypto.randomUUID()` | `op_id` generation | ✓ | Node ≥ 14.17 (stable in 20.x) | None needed |
| `crypto.createHash('sha256')` | Content hashes + Phase 7 reuse | ✓ | Node all LTS versions | None needed |
| `fs.open('a') + fd.sync()` | Manifest durability | ✓ | Node ≥ 10.x | None needed (core primitive) |
| Windows CI runner | SC-9 matrix | ✗ (current CI has ubuntu + macos only) | — | Plan task: add `windows-latest` to matrix in `.github/workflows/ci.yaml` |

**Missing dependencies with no fallback:**
- Windows `wmic` on Windows 11 — may need PowerShell fallback. Planner: spike this on `windows-latest` CI early (first plan or Plan 02).

**Missing dependencies with fallback:**
- None critical. All runtime primitives are Node built-ins.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.x (in-source tests via `if (import.meta.vitest)`) |
| Config file | `vitest.config.ts` (root projects mode) + per-workspace `packages/*/vitest.config.ts` + `apps/ccaudit/vitest.config.ts` |
| Quick run command | `pnpm exec vitest --run packages/internal/src/remediation/` |
| Full suite command | `pnpm exec vitest --run --coverage` |
| CI matrix | `ubuntu-latest`, `macos-latest` (SC-9 adds `windows-latest`) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RMED-01 | `--dangerously-bust-ghosts` flag registered, routes through ghost command | integration (subprocess) | `pnpm exec vitest --run apps/ccaudit/src/__tests__/bust-command.test.ts` | ❌ Wave 0 |
| RMED-02 | Two-gate checkpoint verification (D-01) — missing file, wrong hash | unit | `pnpm exec vitest --run packages/internal/src/remediation/bust.ts` | ❌ Wave 0 |
| RMED-03 | Running-process detection refuses bust with exit 3 (D-02, D-03) | unit + mocked-spawn integration | `pnpm exec vitest --run packages/internal/src/remediation/processes.ts` | ❌ Wave 0 |
| RMED-03 (D-04) | Self-invocation detection via parent-pid chain | unit with mocked ps | same | ❌ Wave 0 |
| RMED-04 | Agents archived to `_archived/` with nested path preservation + ISO collision suffix (D-05) | integration with tmpdir | `pnpm exec vitest --run packages/internal/src/remediation/bust.ts` | ❌ Wave 0 |
| RMED-05 | Skills archived to `_archived/` with collision handling | integration with tmpdir | same | ❌ Wave 0 |
| RMED-06 | MCP key-rename in `~/.claude.json` preserving valid JSON; collision via ISO suffix (D-06) | integration with tmpdir + atomic write | same | ❌ Wave 0 |
| RMED-07 | Memory frontmatter patch — 10 fixture cases covering all D-08 scenarios | unit | `pnpm exec vitest --run packages/internal/src/remediation/frontmatter.ts` | ❌ Wave 0 |
| RMED-07 (D-07) | Idempotent refresh updates `ccaudit-flagged` timestamp on re-flag | unit | same | ❌ Wave 0 |
| RMED-08 | JSONL manifest per-op fsync, header+footer records (D-09 through D-12) | integration with tmpdir | `pnpm exec vitest --run packages/internal/src/remediation/manifest.ts` | ❌ Wave 0 |
| RMED-09 | Atomic write pattern + Windows EPERM retry loop with mocked rename | unit | `pnpm exec vitest --run packages/internal/src/remediation/atomic-write.ts` | ❌ Wave 0 |
| RMED-09 (SC-9) | Full round-trip on `windows-latest` CI | integration in matrix | `pnpm exec vitest --run` (OS matrix) | ❌ Wave 0 (add `windows-latest` job) |
| RMED-09 (regression) | Phase 7 `writeCheckpoint` tests still pass after D-18 extraction | unit | `pnpm exec vitest --run packages/internal/src/remediation/checkpoint.ts` | ✅ Exists |
| RMED-10 (D-15) | Two-prompt ceremony — accept, abort y/N, abort phrase, retry-on-typo, max retries | unit with mocked stdin via Readable stream | `pnpm exec vitest --run packages/internal/src/remediation/bust.ts` | ❌ Wave 0 |
| RMED-10 (D-16) | `--yes-proceed-busting` bypasses both prompts | integration (subprocess) | `apps/ccaudit/src/__tests__/bust-command.test.ts` | ❌ Wave 0 |
| RMED-10 (D-17) | Non-TTY without bypass exits 4 | integration (piped stdin) | same | ❌ Wave 0 |
| Exit codes | 0 / 1 / 2 / 3 / 4 ladder all distinguishable | integration (subprocess) | same | ❌ Wave 0 |
| Failure policy (D-14) | Hybrid continue-on-error for fs ops, fail-fast for `~/.claude.json` | unit + integration | `packages/internal/src/remediation/bust.ts` + subprocess test | ❌ Wave 0 |
| Requirements amendment | RMED-02 wording updated to remove "recent" gate | documentation | grep check: `grep -q 'checkpoint is recent' .planning/REQUIREMENTS.md && exit 1 || exit 0` | ❌ Plan task |

### Sampling Rate

- **Per task commit:** `pnpm exec vitest --run packages/internal/src/remediation/` (runs only the remediation module — fast, sub-5s)
- **Per wave merge:** `pnpm exec vitest --run --coverage` (full workspace, covers regression against Phase 7)
- **Phase gate:** Full suite green on all three OS matrix runners (ubuntu / macos / windows) before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `packages/internal/src/remediation/atomic-write.ts` + in-source tests — extracts Phase 7 pattern + EPERM retry with mocked fs.rename (covers RMED-09)
- [ ] `packages/internal/src/remediation/collisions.ts` + in-source tests — ISO suffix helpers for filenames and JSON keys (covers D-05, D-06 collision cases)
- [ ] `packages/internal/src/remediation/processes.ts` + in-source tests — ps/tasklist parsing with mocked child_process output (covers RMED-03 / D-02 / D-04)
- [ ] `packages/internal/src/remediation/frontmatter.ts` + in-source tests — 10-fixture set per Pattern 4 (covers RMED-07 / D-07 / D-08)
- [ ] `packages/internal/src/remediation/manifest.ts` + in-source tests — JSONL open/write/sync/close + header/footer + schema types (covers RMED-08 / D-09 through D-12)
- [ ] `packages/internal/src/remediation/bust.ts` + in-source tests — orchestrator with injected dependencies (checkpoint reader, process detector, confirmation prompt, manifest writer) so unit tests can assert the full bust pipeline without touching real fs or spawning real ps (covers RMED-01 / RMED-02 / D-13 / D-14 / D-15)
- [ ] `apps/ccaudit/src/__tests__/bust-command.test.ts` — subprocess integration test that spawns `dist/index.js --dangerously-bust-ghosts` with tmpdir HOME, asserts exit codes 0/1/2/3/4 across scenarios, asserts piped-stdin non-TTY exit 4, asserts `--yes-proceed-busting` bypass (covers RMED-01 / RMED-10 / D-15 / D-16 / D-17)
- [ ] `.github/workflows/ci.yaml` — add `windows-latest` to the test matrix (covers SC-9)
- [ ] `.planning/REQUIREMENTS.md` RMED-02 amendment — drop "checkpoint is recent" gate wording (covers D-01 amendment task)

### Output Mode Applicability Matrix (Claude's Discretion → RESOLVED)

| Mode | On `--dangerously-bust-ghosts` | Rationale |
|------|-------------------------------|-----------|
| `--json` | **HONORED.** Emits `buildJsonEnvelope('ghost', sinceStr, exitCode, { bust: { manifestPath, counts, savings, duration_ms, failed_ops: [...] } })` after bust completes. Consistent with Phase 7 dry-run shape. |
| `--csv` | **REJECTED.** Print a warning to stderr: `--csv is not supported on --dangerously-bust-ghosts; use --json for a structured report`. Exit 1 if both flags set. The plan items list is already in the manifest JSONL — a flat CSV would be a redundant duplicate. |
| `--quiet` | **HONORED for progress output.** Suppresses decorative log lines and per-op echo. The final summary (`Done. Saved ~Xk tokens.`) is also suppressed. Exit code is the only signal. Pairs with `--yes-proceed-busting` for non-TTY scripted use. |
| `--verbose` | **HONORED.** Per-op log lines to stderr (`[ccaudit]  → archived agent foo (~2k tokens)`). Pair with `--yes-proceed-busting` for diagnostic non-TTY runs. |
| `--ci` | **HONORED, extended.** `--ci` implies `--json --quiet --yes-proceed-busting`. Rationale: CI scripts that run bust must be non-interactive (`--yes-proceed-busting`), machine-readable (`--json`), and free of decoration (`--quiet`). Adding the `--yes-proceed-busting` implication removes a footgun ("why is my CI hanging on bust?"). **Important:** document this prominently in the README because `--ci` elsewhere does NOT imply destructive-consent. |
| `--no-color` / `NO_COLOR` | **HONORED.** All color output suppressed per Phase 6 precedent. |

### Exit Code Ladder (Claude's Discretion → RESOLVED)

| Code | Meaning | Source |
|------|---------|--------|
| 0 | Clean: bust completed with zero op failures (or no ghosts to bust) | D-14 |
| 1 | Op failures: at least one independent fs op failed (see manifest) OR a non-fatal error (scan failure, corrupt `~/.claude.json`) | D-14 + Phase 6 precedent |
| 2 | Phase 7 checkpoint WRITE failure (reserved for dry-run only; bust reads checkpoint, doesn't write) | Phase 7 D-20 |
| 3 | Running-process preflight failure (D-02, D-03, D-04) | D-03 |
| 4 | Non-TTY without `--yes-proceed-busting` | D-17 |

Planner MUST add this table to `README.md` and `docs/JSON-SCHEMA.md` per CONTEXT.md "exit code ladder consolidation" discretion item.

## Sources

### Primary (HIGH confidence)

- **Existing codebase** (authoritative):
  - `packages/internal/src/remediation/checkpoint.ts` — Phase 7 atomic write pattern (source of D-18 extraction)
  - `packages/internal/src/remediation/change-plan.ts` — plan builder + types
  - `packages/internal/src/scanner/scan-mcp.ts` — `readClaudeConfig` + `ClaudeConfig` interface
  - `packages/internal/src/scanner/scan-agents.ts` — reveals nested subdirectory pattern (basis for Open Question 1)
  - `packages/internal/src/scanner/scan-memory.ts` — confirms memory scanner scope = `CLAUDE.md` + `rules/*.md` only
  - `apps/ccaudit/src/cli/commands/ghost.ts` — Phase 7 dry-run branch (template for bust branch)
  - `apps/ccaudit/src/cli/_shared-args.ts` + `_output-mode.ts` — flag system
  - `.github/workflows/ci.yaml` — current matrix (ubuntu + macos; missing windows)

- **Node.js 22 documentation** — [File system](https://nodejs.org/api/fs.html), [child_process](https://nodejs.org/api/child_process.html), [readline](https://nodejs.org/api/readline.html), [crypto](https://nodejs.org/api/crypto.html)

- **Empirical verification on researcher's macOS machine (Node 22.20.0):**
  - `ps -A -o pid=,comm=` output format confirms `claude` as literal basename
  - `fs.open(path, 'a') + fd.write + fd.sync()` confirmed working for JSONL append
  - `new Date().toISOString().replace(/:/g, '-')` confirmed valid on APFS
  - `crypto.randomUUID()` confirmed zero-dep on Node 22.20.0
  - `process.ppid` + `ps -o ppid= -p <pid>` walks parent chain successfully

- **graceful-fs source code** — [polyfills.js rename retry](https://github.com/isaacs/node-graceful-fs) — canonical Windows EPERM retry pattern (60s total, 10ms-increment backoff capped at 100ms, stat-before-retry)

### Secondary (MEDIUM confidence)

- [fs-no-eperm-anymore defaults](https://github.com/vladimiry/fs-no-eperm-anymore) — alternative retry schedule (100ms fixed interval, 10s total); referenced for comparison, our design follows graceful-fs's backoff pattern with a shorter 10s total for CLI-appropriate latency
- [atomically package](https://www.npmjs.com/package/atomically) — confirms retry timeout pattern (7500ms async default) is widely used
- [Node issue #29481 — EPERM on Windows rename](https://github.com/nodejs/node/issues/29481) — context on the Defender race
- [write-file-atomic issue #28](https://github.com/npm/write-file-atomic/issues/28) — confirms the problem pattern we're solving

### Tertiary (LOW confidence, flagged for validation)

- **Windows `tasklist` CSV output format** — documented in Microsoft docs but not empirically verified by the researcher (no Windows machine available). Planner should verify output format on first `windows-latest` CI run before finalizing `parseTasklistCsv`.
- **Windows 11 `wmic` deprecation** — reported in recent Microsoft posts; the parent-pid lookup may need a PowerShell fallback on Win 11. Planner should spike this on `windows-latest` CI.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all primitives are Node built-ins or existing project internals, all empirically verified on researcher's machine
- Architecture patterns: HIGH — every pattern has a concrete code example and source attribution
- Pitfalls: HIGH — grounded in graceful-fs issue history, Node core issue tracker, and empirical tests
- Output matrix + exit codes: HIGH — resolved with explicit rationale
- Frontmatter patcher fixture set: HIGH — based on actual sampling of real memory files in researcher's .claude directory
- Windows EPERM retry schedule: HIGH — based on graceful-fs canonical pattern, adapted for CLI-appropriate total timeout
- Process matching regex: HIGH — empirically verified on macOS; Windows portion is MEDIUM (documented but not empirically tested)
- Nested agent archive path (Open Question 1): HIGH — grounded in scanner code review

**Research date:** 2026-04-05
**Valid until:** 2026-05-05 (stable dependencies, stable Node built-ins, stable Windows EPERM pattern)

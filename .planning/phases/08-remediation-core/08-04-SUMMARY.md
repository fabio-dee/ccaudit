---
phase: 08-remediation-core
plan: 04
subsystem: remediation-infrastructure
tags: [jsonl-manifest, fsync-durability, crash-survival, content-hashing, header-footer-bracket, zero-deps]
dependency_graph:
  requires:
    - Plan 08-01 (atomic-write.ts + index.ts barrel — preserved, not disturbed)
    - Plan 08-02 (collisions.ts timestampSuffixForFilename reused for the per-bust filename — preserved)
    - Plan 08-03 (frontmatter.ts + index.ts exports — preserved, not disturbed)
  provides:
    - packages/internal/src/remediation/manifest.ts (ManifestWriter class, readManifest, 5 op builders, header/footer builders, discriminated record types)
    - ManifestWriter open → writeOp → close lifecycle with per-op fsync for SIGKILL survivability (D-09)
    - resolveManifestPath helper producing ~/.claude/ccaudit/manifests/bust-<iso-dashed>.jsonl with dir 0o700 / file 0o600 (D-10)
    - 5-variant ManifestOp discriminated union matching D-11 schema byte-for-byte (archive / disable / flag / refresh / skipped)
    - Header + footer bracket records (D-12) enabling Phase 9 crash detection rule (header-present + footer-missing = partial bust)
    - Content hashing (sha256) on archive source bytes and flag original_content bytes for Phase 9 tamper detection
    - Crash-tolerant readManifest that skips a single trailing truncated line and raises on mid-file corruption
  affects:
    - Wave 1 bust orchestrator (Plan 08-05): will instantiate ManifestWriter, call buildHeader/buildFooter + op builders, own the open → loop → close lifecycle
    - Phase 9 restore: consumes readManifest output, pattern-matches op_type on each record to invert the bust, uses content_sha256 to detect post-bust tampering before restoring
tech_stack:
  added:
    - node:fs/promises FileHandle + fd.sync() pattern (new to the codebase — append-only with per-op durability, distinct from the tmp + rename atomic-write pattern)
    - node:crypto createHash('sha256') reused from checkpoint.ts for the new content_sha256 fields
    - node:crypto randomUUID for op_id generation (first use in codebase)
  patterns:
    - Discriminated-union record types (ManifestRecord = ManifestHeader | ManifestOp | ManifestFooter) with op_type / record_type as the discriminant so callers and Phase 9 reader can narrow safely
    - Single-write concatenation (JSON.stringify(x) + '\n' in ONE fd.write call) per RESEARCH Pitfall 5 — avoids the two-syscall partial-line race
    - Belt-and-suspenders file mode: open(path, 'a', 0o600) on create + chmod 0o600 after (swallows Windows EPERM)
    - Omit<Header, 'record_type' | 'manifest_version'> builder input shape so callers can't accidentally pass wrong literal types
    - Real-tmpdir fixtures via mkdtemp + rm afterEach (no fs injection — the behavior under test IS the disk round-trip)
    - Reader tolerance contract encoded at a specific call site: i === lines.length - 1 gate, mid-file errors raise
key_files:
  created:
    - packages/internal/src/remediation/manifest.ts (723 lines including in-source tests)
    - .planning/phases/08-remediation-core/08-04-SUMMARY.md (this file)
  modified:
    - packages/internal/src/remediation/index.ts (appended Plan 04 block below Plans 01 + 02 + 03 blocks; prior exports preserved byte-for-byte)
decisions:
  - D-09 encoded as a single fd.write + fd.sync per op (not buffered, not batched) — the SIGKILL survivability contract is "at most one truncated line" and only per-op fsync guarantees that
  - D-10 per-bust filename uses the Plan 02 timestampSuffixForFilename helper so archive paths + disabled MCP keys + manifest filenames all share one ISO formatter (dashed colons, no ms)
  - D-11 status field type narrowed: SkippedOp.status is literal 'completed' only (the status discriminant carries no meaning for a skipped op but making it uniform across the union keeps callers from special-casing)
  - D-11 content_sha256 input accepts Buffer OR string — string path Buffer.from(x, 'utf8') internally so call sites can pass readFile output directly without ceremony
  - D-11 error?: string marked optional AND conditionally spread (`...(input.error !== undefined ? { error: input.error } : {})`) so serialised JSON lines omit the field entirely when absent — keeps the manifest minimally noisy for success cases
  - D-12 header built with Omit<..., 'record_type' | 'manifest_version'> input so the literals cannot drift from the schema constant MANIFEST_VERSION = 1
  - D-12 footer omitted on failure via `close(null)` — the sentinel null is explicit (not undefined / default) to force callers to pass the bust outcome intentionally
  - readManifest trailing-truncation tolerance is gated on `i === lines.length - 1` specifically (the last line in the split, after stripping the trailing empty line from '\n' terminator) — the plan's intent is "at most one truncated line at the very end" and this encoding matches that precisely
  - Content hash helper sha256Hex extracted as a module-private function since both buildArchiveOp and buildFlagOp need identical Buffer|string handling
  - Real fs with mkdtemp chosen over fs injection — ManifestWriter is inherently I/O-bound (its invariants ARE the disk state: fsync ordering, file mode, header-before-ops) and injecting fs would reduce the assertion surface to "we wrote the right strings" without verifying actual durability/ordering
  - No architectural deviations required from Plans 01/02/03; all prior exports preserved byte-for-byte
requirements_completed: [RMED-08]
metrics:
  duration: ~8.5 minutes (513s wall-clock)
  completed_date: 2026-04-05
  tasks_completed: 1 (TDD: RED → GREEN)
  commits: 2
  tests_added: 15 (in manifest.ts, all passing)
  full_remediation_suite: 115 passing + 1 skipped (up from 100+1 post-Plan-03, delta exactly +15)
  full_workspace_tests: 445 passing + 1 skipped (up from 430+1 post-Plan-03, delta exactly +15)
---

# Phase 8 Plan 04: JSONL Restore Manifest Writer Summary

Shipped `packages/internal/src/remediation/manifest.ts` — an append-only JSONL restore manifest writer with per-op `fd.sync()` durability, header + footer bracket records enabling Phase 9 crash detection, a 5-variant discriminated-union op schema with sha256 content hashes for tamper detection, and a crash-tolerant reader that silently skips a single trailing truncated line while raising on mid-file corruption. Zero runtime deps — `node:fs/promises` + `node:path` + `node:os` + `node:crypto` only.

## What Was Built

### Module layout (723 lines)

- **Header type** (D-12) — `ManifestHeader` with `manifest_version: 1`, `ccaudit_version`, `checkpoint_ghost_hash`, `checkpoint_timestamp`, `since_window`, `os`, `node_version`, `planned_ops: { archive, disable, flag }`
- **5 op types** (D-11) — `ArchiveOp | DisableOp | FlagOp | RefreshOp | SkippedOp` with `op_type` as discriminant
- **Footer type** (D-12) — `ManifestFooter` with `actual_ops` (archive/disable/flag buckets), `duration_ms`, `exit_code`
- **`ManifestRecord`** — the full union `ManifestHeader | ManifestOp | ManifestFooter` that the reader returns
- **`resolveManifestPath(now?)`** — returns `~/.claude/ccaudit/manifests/bust-<iso-dashed>.jsonl` using the Plan 02 `timestampSuffixForFilename` helper
- **7 builder factories** — `buildHeader`, `buildFooter`, `buildArchiveOp`, `buildDisableOp`, `buildFlagOp`, `buildRefreshOp`, `buildSkippedOp`
- **`ManifestWriter` class** — `open(header)` / `writeOp(op)` / `close(footer | null)` with a private `FileHandle` + `fd.sync()` per write
- **`readManifest(path)`** — crash-tolerant parser returning `{ header, ops, footer, truncated }`

### Critical invariants enforced

1. **Per-op durability (D-09)**: every `writeOp` issues a single `fd.write(JSON.stringify(op) + '\n')` (one syscall, not two — per Pitfall 5) followed by `fd.sync()`. After `open()` returns, the header line is on disk. After every `writeOp` returns, that op line is on disk. SIGKILL at any point leaves at most one truncated trailing line.
2. **Header before ops (D-12)**: `open()` writes and fsyncs the header BEFORE returning. No op can be written without a preceding header.
3. **Footer only on success (D-12)**: `close(footer)` writes the footer; `close(null)` closes the fd without writing a footer. The sentinel `null` is explicit — Phase 9 detects `header present + footer missing` as a partial bust.
4. **File permissions (D-10)**: `open(path, 'a', 0o600)` + follow-up `chmod(path, 0o600)` (swallows Windows EPERM). Parent directory created with `mkdir({ recursive: true, mode: 0o700 })`.
5. **Per-bust filename (D-10)**: `bust-<iso-dashed>.jsonl` under `~/.claude/ccaudit/manifests/` — reuses the Plan 02 `timestampSuffixForFilename` helper so archive paths, disabled MCP keys, and manifest filenames all share one ISO format.
6. **Content hashing (D-11)**: `buildArchiveOp` and `buildFlagOp` compute `content_sha256` from source bytes via a module-private `sha256Hex(Buffer | string)` helper. Phase 9 uses these to detect post-bust tampering before restoring.
7. **Reader truncation tolerance (D-09)**: `readManifest` splits on `'\n'`, strips the trailing empty line from the final `\n` terminator, then parses each remaining line. A `JSON.parse` failure on `i === lines.length - 1` sets `truncated: true` and is tolerated. A parse failure on any earlier line raises `Manifest parse error at line N: invalid JSON`.

### Exports added to `packages/internal/src/remediation/index.ts`

Appended Plan 04 block below Plans 01 + 02 + 03 blocks, byte-for-byte preserved:

```typescript
// Phase 8: JSONL restore manifest writer + reader (D-09 / D-10 / D-11 / D-12)
export {
  ManifestWriter, resolveManifestPath, readManifest,
  buildHeader, buildFooter,
  buildArchiveOp, buildDisableOp, buildFlagOp, buildRefreshOp, buildSkippedOp,
  MANIFEST_VERSION,
} from './manifest.ts';
export type {
  ManifestHeader, ManifestFooter, ManifestOp, ManifestRecord,
  ArchiveOp, DisableOp, FlagOp, RefreshOp, SkippedOp,
  ReadManifestResult,
} from './manifest.ts';
```

## Test Coverage (15 tests, all passing)

- **`resolveManifestPath`** — returns the D-10 path with dashed ISO suffix
- **`buildArchiveOp`** (3 tests) — fills uuid + timestamp + content hash, accepts Buffer content, honors failed status + error
- **`buildDisableOp` / `buildFlagOp` / `buildRefreshOp` / `buildSkippedOp`** (4 tests) — each produces the correct discriminated variant with all D-11 fields
- **`ManifestWriter`** (4 tests) — open writes header as line 1, writeOp appends one line per call, close(null) omits footer, POSIX dir/file modes (skipped on Windows)
- **`readManifest`** (3 tests) — full round-trip header + 3 ops + footer, trailing truncated line tolerated (crash survival), mid-file corruption raises

All tests use `mkdtemp(tmpdir, 'manifest-*')` real-filesystem fixtures with `afterEach` cleanup — no fs injection, because the invariants under test ARE disk state (fsync ordering, mode bits, header-before-ops).

## Performance

- 15 tests run in ~85ms on a 2021 MacBook Pro
- Full remediation suite (8 files, 115 tests) runs in ~250ms
- Full workspace suite (50 files, 445 tests) runs in ~1.6s
- No regression in prior tests; delta is exactly +15 as expected

## Deviations from Plan

None — the plan was implemented verbatim with the single minor adjustment that the `sha256Hex` helper is extracted as a module-private function (the plan inlined the `createHash(...).update(buf).digest('hex')` call in each builder; factoring out removes duplication with no behavioral change).

## What's Next (Plan 08-05)

Plan 08-05 is the bust orchestrator — it will instantiate `ManifestWriter`, call `buildHeader` with the fresh change plan's `planned_ops` counts, then drive the execute loop (archive agents → archive skills → disable MCP → flag memory per D-13), calling `buildArchiveOp` / `buildDisableOp` / `buildFlagOp` / `buildRefreshOp` / `buildSkippedOp` per operation and `writer.writeOp(...)` to record each one. On successful completion it builds a footer from the actual op counters and calls `writer.close(footer)`. On any failure path it calls `writer.close(null)` so Phase 9 sees the partial-bust marker.

## Self-Check: PASSED

- **manifest.ts exists**: `packages/internal/src/remediation/manifest.ts` (723 lines, verified)
- **Commit 3615dd4 (RED) exists**: `test(08-04): add failing tests for JSONL manifest writer`
- **Commit eb7e882 (GREEN) exists**: `feat(08-04): implement JSONL manifest writer with per-op fsync`
- **All 15 tests pass**: `pnpm exec vitest --run packages/internal/src/remediation/manifest.ts` exits 0
- **Full remediation suite passes**: 115 + 1 skipped (delta +15 vs baseline)
- **Full workspace passes**: 445 + 1 skipped (delta +15 vs baseline)
- **Typecheck passes**: `pnpm -F @ccaudit/internal typecheck` exits 0
- **All 18 grep acceptance criteria satisfied** (ManifestWriter / resolveManifestPath / readManifest / MANIFEST_VERSION = 1 / record_type: 'header' / record_type: 'footer' / 5 op builders / fd.sync / mode 0o600 / mode 0o700 / randomUUID / createHash('sha256') / truncated = true / index.ts barrel)
- **Prior exports preserved**: Plans 01/02/03 barrel entries in index.ts unchanged byte-for-byte

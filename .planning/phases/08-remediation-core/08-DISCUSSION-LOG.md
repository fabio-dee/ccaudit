# Phase 8: Remediation Core - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-05
**Phase:** 08-remediation-core
**Areas discussed:** Safety gates, Collision & idempotency, Restore manifest, Failure & ordering

---

## Area selection

| Option | Description | Selected |
|--------|-------------|----------|
| Safety gates | Checkpoint gate #3 conflict (RMED-02 vs PROJECT.md hash-only), running-process detection mechanism (RMED-03) | ✓ |
| Collision & idempotency | Name collisions in _archived/, duplicate ccaudit-disabled:<name> keys, re-flagging memory | ✓ |
| Restore manifest | Schema, format (JSON vs JSONL), location, crash semantics | ✓ |
| Failure & ordering | Op order, fail-fast vs continue, triple-confirmation wording, non-TTY bypass | ✓ |

**User's choice:** All four areas selected.

---

## Area 1: Safety gates

### Q1: Checkpoint gate #3 semantics (RMED-02 "recent" vs PROJECT.md hash-only)

| Option | Description | Selected |
|--------|-------------|----------|
| Drop gate #3 (2-gate system) | Only gates (1) exists + (2) hash matches. Amend RMED-02. Matches PROJECT.md Key Decision and Phase 7 D-15. | ✓ |
| Soft-warn only | Keep checking age but only warn, not block. Arbitrary threshold like 1h. | |
| Hard block >24h | Keep handoff §113 ≤24h rule as hard block. Reverts the Key Decision. | |

**User's choice:** Drop gate #3 (Recommended).
**Notes:** Captured as D-01 in CONTEXT.md. REQUIREMENTS.md RMED-02 needs amendment during planning — flagged as a deliverable.

### Q2: Running-process detection mechanism (RMED-03)

| Option | Description | Selected |
|--------|-------------|----------|
| ps scan with conservative match | Shell out to `ps -A -o comm=` (Unix) / `tasklist /FO CSV /NH` (Windows), self-pid excluded. Zero-dep, cross-platform. | ✓ |
| Exclusive file-lock attempt | fs.open + advisory lock. Brittle on macOS. | |
| Check for PID/socket file | Look for Claude Code's pid/socket file. Brittle against version changes. | |
| Both ps-scan AND file-lock | Defense in depth. Most conservative but rejects valid busts if either flakes. | |

**User's choice:** ps scan with conservative match (Recommended).
**Notes:** Captured as D-02. Researcher should validate exact executable names (`claude` / `Claude.exe` / `Claude Code`) during phase-researcher step.

### Q3: Behavior on positive detection

| Option | Description | Selected |
|--------|-------------|----------|
| Refuse, exit 3, print stop-and-retry instructions | New exit code 3 distinct from 1 and 2. No bypass flag. | ✓ |
| Refuse + --allow-unsafe-concurrent-write bypass | Same refusal + deliberately ugly override flag. | |
| Refuse, exit 1, no bypass | Simplest but makes "ghosts found" indistinguishable from "Claude is running". | |

**User's choice:** Refuse, exit 3, no bypass (Recommended).
**Notes:** Captured as D-03. No legitimate workflow requires bypassing this gate; ~/.claude.json OAuth tokens are too important.

### Q4: Self-invocation edge case (ccaudit run from inside Claude Code)

| Option | Description | Selected |
|--------|-------------|----------|
| Detect self-invocation, custom message | Tailored "open a standalone terminal" error when parent chain contains Claude Code. | ✓ |
| Generic message, same exit code | Treat identically to any running Claude Code. User figures out it's themselves. | |
| Allow when invoked from the session being audited | Dangerous — concurrent writes still corrupt OAuth tokens. Rejected on safety grounds. | |

**User's choice:** Detect self-invocation, custom message (Recommended).
**Notes:** Captured as D-04. The Bash-tool-inside-Claude-Code footgun is the most likely failure mode; the custom message names the scenario explicitly.

### Q5: Ready to move on?

**User's choice:** Move to Collision & idempotency.

---

## Area 2: Collision & idempotency

### Q1: Archive filename collisions (repeat bust of same-named agent)

| Option | Description | Selected |
|--------|-------------|----------|
| Append ISO timestamp suffix | _archived/code-reviewer.2026-04-05T18-30-00Z.md. Sortable, preserves history, manifest records exact path. | ✓ |
| Append numeric version suffix | _archived/code-reviewer.1.md, .2.md ... Shorter but no time ordering. | |
| Overwrite the existing archive | Last-write-wins. Rejected — loses prior archived content. | |
| Refuse and exit with error | Safe but hostile. | |

**User's choice:** Append ISO timestamp suffix (Recommended).
**Notes:** Captured as D-05. Same policy for skills.

### Q2: MCP ccaudit-disabled:<name> key collisions

| Option | Description | Selected |
|--------|-------------|----------|
| Append ISO timestamp suffix to the key | ccaudit-disabled:playwright:2026-04-05T18-30-00Z. Consistent with archive policy. | ✓ |
| Append numeric version suffix to the key | ccaudit-disabled:playwright:2, :3. Shorter but colon-numeric reads ambiguously. | |
| Overwrite the existing disabled entry | Rejected — symmetric to archive case. | |
| Refuse and exit with error | Same hostility trade-off. | |

**User's choice:** Append ISO timestamp suffix to the key (Recommended).
**Notes:** Captured as D-06.

### Q3: Re-flagging already-stale memory files

| Option | Description | Selected |
|--------|-------------|----------|
| Refresh ccaudit-flagged timestamp, keep ccaudit-stale: true, verbose log | Idempotent + informative. Manifest records "refresh" op. | ✓ |
| No-op, skip silently | Obscures which files the current bust touched. | |
| Remove and re-add both keys | Identical end-state but unnecessary rewrite. | |

**User's choice:** Refresh ccaudit-flagged timestamp (Recommended).
**Notes:** Captured as D-07. "refresh" is a distinct op_type in the manifest per D-11.

### Q4: YAML frontmatter patching strategy (zero runtime deps)

| Option | Description | Selected |
|--------|-------------|----------|
| Hand-rolled YAML frontmatter patcher | Line-based, fixture-tested, handles simple key:value frontmatter. | ✓ |
| Bundle js-yaml as devDependency, use in build | Safer for exotic YAML but risks reformatting user's existing frontmatter. | |
| Refuse to modify files with existing frontmatter beyond simple key:value | Safe but may skip legitimate files. | |

**User's choice:** Hand-rolled YAML frontmatter patcher (Recommended).
**Notes:** Captured as D-08. Malformed frontmatter → skip + verbose warning + manifest "skipped" op.

---

## Area 3: Restore manifest

### Q1: File format for incremental restore manifest

| Option | Description | Selected |
|--------|-------------|----------|
| JSONL, one op per line, append + fsync per write | Crash-safe by design. Open once, fd.write + fd.sync per op, close at end. | ✓ |
| Single JSON file, rewritten after every op | O(n²) writes. Defeats the "incremental" intent of RMED-08. | |
| Two-file pattern — JSONL stream + final JSON commit | Cleanest completed artifact but more complex reader. | |

**User's choice:** JSONL + append + fsync (Recommended).
**Notes:** Captured as D-09.

### Q2: Manifest location strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Per-bust timestamped file in ~/.claude/ccaudit/manifests/ | bust-<ISO>.jsonl. Phase 9 picks newest by mtime. Full history preserved. | ✓ |
| Single overwritten file at ~/.claude/ccaudit/.last-bust.jsonl | Simplest but history of past busts is lost. | |
| Rotating file: .last-bust.jsonl during run, moved to history/ on success | Crashed busts leave a "dirty marker" Phase 9 can detect. | |

**User's choice:** Per-bust timestamped file (Recommended).
**Notes:** Captured as D-10. Colons in timestamp replaced with dashes for filesystem safety.

### Q3: Per-op schema (what each JSONL line contains)

| Option | Description | Selected |
|--------|-------------|----------|
| Full schema with content hashes | op_id, op_type, timestamp, status, + per-type fields including content_sha256 (archive) and original_value (disable). Enables tamper detection and exact restore. | ✓ |
| Minimal schema, no hashes | op_type, timestamp, paths. Smaller but no tamper detection. | |
| Full schema without content hashes | Include original_value + patched_keys, skip content_sha256. | |

**User's choice:** Full schema with content hashes (Recommended).
**Notes:** Captured as D-11. Adds "skipped" op_type for D-08 malformed-frontmatter cases.

### Q4: Header + footer records

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — header + footer | Header on line 1 (manifest_version, checkpoint_ghost_hash, planned_ops). Footer on success (status, actual_ops, duration). Phase 9 detects crashed mid-bust via header-present + footer-missing. | ✓ |
| Header only, no footer | Completed vs crashed inferred by counting ops vs header.planned_ops. Implicit. | |
| Neither — ops only | Simplest, no crash detection. | |

**User's choice:** Header + footer (Recommended).
**Notes:** Captured as D-12.

---

## Area 4: Failure & ordering

### Q1: Operation execution order

| Option | Description | Selected |
|--------|-------------|----------|
| Archive → Disable MCP → Flag memory | Least-risk fs ops first, risky ~/.claude.json middle (gated), additive frontmatter last. | ✓ |
| Disable MCP → Archive → Flag memory | High-risk first so failure aborts before any fs changes. Downside: silent success if crashed after. | |
| Flag memory → Archive → Disable MCP | Lowest-value first. No early proof of success. | |

**User's choice:** Archive → Disable MCP → Flag memory (Recommended).
**Notes:** Captured as D-13.

### Q2: Per-op failure policy

| Option | Description | Selected |
|--------|-------------|----------|
| Continue-on-error for independent fs ops, fail-fast for ~/.claude.json | Hybrid. Each agent/skill/memory op is independent. ~/.claude.json is transactional. | ✓ |
| Fail-fast on any error | Safest but hostile if one quarantined file blocks 127 others. | |
| Best-effort continue-on-error everywhere | Rejected — partial ~/.claude.json writes are catastrophic. | |

**User's choice:** Hybrid (Recommended).
**Notes:** Captured as D-14.

### Q3: Triple confirmation UX (initial question)

| Option | Description | Selected |
|--------|-------------|----------|
| Handoff §145-150 verbatim, trim + exact-case, 3 retries | 3-prompt ceremony. [1/3] y/N → [2/3] y/N → [3/3] type "I accept full responsibility". | |
| Case-insensitive match on phrase 3 | Softens the ceremony. | |
| Single composite prompt | Loses the step-by-step ceremony. Rejected. | |

**User's choice:** Custom ("Other"). User note: **"Let's do Option 1 but with 2 confirmations instead of 3, and make the sentence less verbose like 'proceed busting'"**.

### Q3a (follow-up): Two-prompt structure

| Option | Description | Selected |
|--------|-------------|----------|
| [1/2] y/N + [2/2] type 'proceed busting' | Keeps typed-phrase ceremony (screenshot asset) but drops middle "are you sure?" and shortens phrase. | ✓ |
| [1/2] y/N + [2/2] y/N | Both simple y/N. Loses viral typed-phrase moment. | |
| [1/2] y/N + [2/2] type 'bust ghosts' | Punchier but reads too casually for destructive op. | |

**User's choice:** [1/2] y/N + [2/2] type 'proceed busting' (Recommended).
**Notes:** Captured as D-15. Deviates from handoff §145-150 — the handoff will be updated during planning.

### Q3b (follow-up): Non-TTY bypass flag name

| Option | Description | Selected |
|--------|-------------|----------|
| --yes-proceed-busting | Matches typed phrase. Deliberately ugly. Same incantation in TTY and non-TTY. | ✓ |
| --yes-bust-ghosts | Shorter, echoes main flag. Risks reading like a shortcut. | |
| --yes-i-accept-full-responsibility | Keeps original flag despite interactive phrase change. Asymmetric. | |

**User's choice:** --yes-proceed-busting (Recommended).
**Notes:** Captured as D-16.

### Q4: Non-TTY / CI behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Refuse unless --yes-proceed-busting flag passed | Ugly flag + informative error message. Exit 4 reserved for this case. | ✓ |
| Refuse entirely in non-TTY, no bypass | Rejects legitimate solo-dev GitHub Actions use cases. | |
| --yes / -y flag, same in TTY and non-TTY | Short flag risks accidental copy-paste. | |

**User's choice:** Refuse unless --yes-proceed-busting passed (Recommended).
**Notes:** Captured as D-17.

---

## Additional gray areas (offered but not discussed)

User chose to finalize CONTEXT.md rather than explore more gray areas. Deferred to researcher / planner / Claude's discretion:

- **Windows EPERM retry schedule** (SC #9) — researcher to investigate during phase-researcher step
- **Output mode applicability matrix** (`--json` / `--csv` / `--quiet` / `--ci` on bust) — planner to propose
- **Exit code ladder consolidation** — planner to add a documentation table
- **Progress rendering UX during bust** — Claude's discretion
- **Exact stderr wording** for refusal messages — Claude's discretion

## Claude's Discretion (captured in CONTEXT.md)

- Module layout inside `packages/internal/src/remediation/`
- UUID generation library choice (recommend `crypto.randomUUID()`)
- Fixture strategy for Windows CI (unit + integration)
- Exact stderr message wording for D-03, D-04, D-17

## Deferred Ideas (captured in CONTEXT.md)

- Windows EPERM exponential-backoff schedule
- Output mode applicability matrix
- Canonical exit code ladder table in README
- TUI progress bar vs simple log lines
- `--target <category>` / `--only agents` power-user flag
- Pre-bust tarball backup
- Multi-bust restore UX (`--from bust-<timestamp>`)
- `ccaudit bust --undo-last` alias for restore
- Tamper-detection behavior on restore (Phase 9 scope)
- `--yes` / `-y` short flag alternative

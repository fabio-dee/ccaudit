# Retrospective

## Milestone: v1.2 — Full Release

**Shipped:** 2026-04-06
**Phases:** 9 | **Plans:** 37 | **Commits:** 229

### What Was Built
- Zero-dep pnpm monorepo, gunshi CLI skeleton, vitest in-source test infrastructure
- JSONL streaming parser with dual-path discovery (XDG + legacy), invocation ledger for agents/skills/MCP
- Ghost scanner with tiered classification (likely/definite), per-project breakdown
- Token attribution from bundled `mcp-token-estimates.json` with `~` prefix confidence tiers + `--live` MCP measurement
- Full CLI suite (ghost/inventory/mcp/trend), health score, per-item recommendations
- CI-ready output: exit codes, NO_COLOR, --quiet/--verbose/--ci, --json/--csv; 80% coverage on ubuntu+macOS+windows
- `ccaudit --dry-run` with SHA-256 ghost-inventory hash + atomic checkpoint write/read
- `ccaudit --dangerously-bust-ghosts` with process gate, two-prompt ceremony, atomic JSON mutations, archive-not-delete
- `ccaudit restore` (full/named/--list) with 13-case subprocess integration test suite

### What Worked
- In-source vitest tests kept test code co-located and stripped from production bundle cleanly
- Injectable deps pattern (Phase 7 StatFn precedent) made subprocess-dependent code fully testable
- Gap closure rounds caught escaped requirements before shipping each milestone segment
- Discriminated union result types (`BustResult`, `RestoreResult`) made exhaustive error handling natural

### What Was Inefficient
- ROADMAP.md progress table was never updated during execution — manual drift
- STATE.md stopped tracking velocity after Phase 6 (still shows 0 completed plans in metrics)
- Phase 6 required 7 plans (4 original + 3 gap closures) — more gaps than expected for a "polish" phase
- Phase 8 accumulated 8 plans partly due to plan-checker blockers requiring additional fix plans

### Patterns Established
- Atomic write pattern (tmp-then-rename, process.pid suffix, 0o700 dir / 0o600 file) reused across checkpoint and bust
- Subprocess integration test pattern: spawn dist/index.js with HOME override, mkdtemp fixture, NO_COLOR=1
- `toKebab: true` at command level required for gunshi camelCase → --kebab-case CLI flags
- `gunshi renderHeader: null` at cli() call site required to suppress banner from JSON/CSV output

### Key Lessons
- Trust the verifier: both Phase 6 and Phase 7 escaped gaps were caught by VERIFICATION.md, not UAT
- Plan-checker blockers are valuable — the 2 extra Phase 8 plans fixed real bugs before production
- Hash-based checkpoint design is correct; time-based would have caused false-positive "stale" errors
- Windows EPERM retry logic (graceful-fs style) required its own plan — never assume rename is atomic on Windows

## Cross-Milestone Trends

| Metric | v1.2 |
|--------|------|
| Phases | 9 |
| Plans | 37 |
| Commits | 229 |
| Production TS | ~16,500 lines |
| Timeline | 4 days |
| Gap closure rounds | 3 (Ph6) + 1 (Ph7) + 1 (Ph9 bug fix) |

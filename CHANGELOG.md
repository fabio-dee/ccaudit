# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-04-11

Framework-aware ghost grouping. Users that install GSD, SuperClaude, n-wave, or
any of the other 10 curated frameworks now see related agents grouped into a
single row with framework-level totals, and the `--dangerously-bust-ghosts`
pipeline protects partially-used frameworks from being half-archived.

### Added

- Framework-aware ghost grouping via a 3-tier detection algorithm
  (curated registry + heuristic prefix clustering + ungrouped).
- New curated registry of 10 well-known frameworks: `gsd`, `superclaude`,
  `nwave`, `superpowers`, `ralph-loop`, `agent-council`, `greg-strategy`,
  `ideabrowser`, `gstack`, `hermes`. See
  `packages/internal/src/framework/known-frameworks.ts`.
- `--verbose` / `-v` flag on `ghost` and `inventory` commands. Expands each
  framework row into a tree of its members; used members collapse to a
  `+ N used members` line.
- `--no-group-frameworks` escape hatch on `ghost` and `inventory`. Reverts
  output to the v1.2.1 layout byte-for-byte (no Frameworks section, no
  additive JSON envelope keys, no framework column in tables).
- `--force-partial` opt-in override on `ghost --dangerously-bust-ghosts` and
  `ghost --dry-run`. Bypasses framework-as-unit protection and archives ghost
  members of partially-used frameworks.
- Additive JSON envelope fields: top-level `.frameworks[]` array (with `id`,
  `displayName`, `source_type`, `status`, `totals`, `memberCount`) and
  per-item `.items[].framework` (string or `null`). Both keys are entirely
  absent when `--no-group-frameworks` is set.
- New `packages/internal/src/framework/` sub-module: types, valibot-validated
  curated registry, `STOP_PREFIXES` and `DOMAIN_STOP_FOLDERS` stop-lists,
  `detectFramework()`, `groupByFramework()`, and `computeFrameworkStatus()`.
- New `packages/internal/src/remediation/framework-bust.ts` pure helper that
  applies framework-as-unit protection to a bust target list without
  touching the existing `bust.ts` orchestrator.
- New `packages/terminal/src/tables/framework-section.ts` renderer used by
  both the ghost and inventory tables.
- Yellow warning block + `PROTECTED` section in the change plan output
  whenever framework protection is active.

### Changed

- `ccaudit ghost` prepends a "Frameworks" section above the ungrouped list
  when any frameworks are detected. Per-category ghost counts annotate with
  `(X in frameworks above)` so totals stay arithmetically sound.
- `ccaudit inventory` groups rows by framework in default mode; verbose mode
  adds a `Framework` column and sorts rows by framework then urgency.
- `ghost --help` and `inventory --help` now list the three new flags with
  descriptions.
- CSV and TSV output in verbose mode gains a trailing `framework` column
  (default-mode CSV/TSV is unchanged for backward compatibility).

### Fixed

- _(none)_

### Backward Compatibility

This release is strictly additive — every existing consumer continues to work
without changes.

- **v1.2.1 jq paths unchanged.** `ccaudit ghost --json | jq '.items[].name'`,
  `.items[].tier`, `.items[].tokenEstimate`, `.meta.timestamp`,
  `.ghosts.total`, and all other v1.2.1 JSON paths continue to resolve.
- **Byte-for-byte escape hatch.** `ccaudit ghost --json --no-group-frameworks`
  produces output byte-for-byte identical to v1.2.1 (after normalizing
  `meta.timestamp` and `meta.version`). No `frameworks` key, no per-item
  `framework` key, no framework column in CSV/TSV, no Frameworks section in
  the terminal output.
- **Restore reads v1.2.1 manifests unchanged.** `ccaudit restore` against a
  v1.2.1 bust manifest completes without modification or error.
- **`bust.ts` and `restore.ts` untouched.** `packages/internal/src/remediation/bust.ts`
  is 1,483 lines, identical to v1.2.1. `packages/internal/src/remediation/restore.ts`
  is 1,987 lines, identical to v1.2.1. All new logic lives in new files.
- **Exit code ladder unchanged.** `0` success, `1` ghosts found / soft error,
  `2` checkpoint write failure, `3` running Claude Code process detected,
  `4` non-TTY without `--yes-proceed-busting`. Framework-level bust and
  restore reuse this ladder — no new exit codes.

## [1.2.1] - 2024-XX-XX

Baseline release prior to framework-aware ghost grouping. See the git history
for details.

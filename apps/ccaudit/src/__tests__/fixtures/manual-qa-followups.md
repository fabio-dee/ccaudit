# Manual QA follow-up fixtures

These fixtures support regressions found during v1.5 manual QA after Phase 10.
They are intentionally filesystem-based so future tests can drive the real CLI
and TTY picker with a disposable `HOME`.

Import from:

```ts
import {
  stageAlreadyPurgedFixture,
  stageGlyphFixture,
  stageInteractiveBustFixture,
  stagePaginationFixture,
  stagePurgeMixedFixture,
} from './fixtures/manual-qa-followups.ts';
```

## Fixture map

| Manual row       | Builder                                                               | Purpose                                                                                                           |
| ---------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Phase 9 G6       | `stageAlreadyPurgedFixture(tmpHome)`                                  | Starts from a post-purge state with `archive_purge` follow-ups. `purge-archive --yes` should be idempotent/no-op. |
| Phase 9 G1/G3/G5 | `stagePurgeMixedFixture(tmpHome)`                                     | Mixed archive classifier: reclaim, source-occupied drop, stale-missing drop, both-missing skip.                   |
| Phase 9 G4       | `stagePurgeMixedFixture(tmpHome, { includeFlagAndDisableOps: true })` | Adds a memory flag op and MCP disable op. Purge should touch archive ops only.                                    |
| Phase 9 E1/E4    | `stageGlyphFixture(tmpHome)`                                          | Creates selected/unselected-capable rows, protected framework row, multi-config MCP row, stale memory row.        |
| Phase 9 D1/D2    | `stagePaginationFixture(tmpHome, 550)`                                | Real 550-agent HOME for TTY pagination/filter/sort tests.                                                         |
| Phase 9 H2       | `stageInteractiveBustFixture(tmpHome)`                                | Minimal real `ghost -i` archive then `restore --name h2-solo` smoke fixture.                                      |

## Notes

- Always set `HOME`, `USERPROFILE`, and `XDG_CONFIG_HOME` to the temp HOME when
  spawning the CLI.
- For interactive tests, use `CCAUDIT_FORCE_TTY=1` only when the test harness
  intentionally simulates a TTY. Real tmux/pty tests should not need it.
- `stageGlyphFixture()` returns `{ projectRoot }`; run the CLI with `cwd` set to
  that project root to ensure project-local `.mcp.json` participates in
  multi-config MCP detection.
- `stageInteractiveBustFixture()` installs a fake `ps` shim in `<tmpHome>/bin`;
  prepend that directory to `PATH` so the running-Claude preflight does not see
  the current development session.

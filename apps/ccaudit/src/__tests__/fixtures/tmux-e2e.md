# tmux E2E fixture driver

`tmux-e2e.ts` is an optional test helper for driving ccaudit TUI flows with a
real terminal emulator layer. It is designed to automate as much of
`ccaudit-manual-tests.txt` as possible without replacing true human-only checks
like macOS Terminal.app drag-resize or GitHub browser rendering.

## Capabilities

The helper can:

- start a detached tmux session with a controlled width/height
- run the built CLI with disposable `HOME` fixtures
- send real key events (`Space`, `Enter`, arrows, `Escape`, `C-c`, etc.)
- send literal filter text
- capture pane output with ANSI stripped by default
- resize the tmux window to simulate SIGWINCH
- wait for expected text in the pane
- cleanly kill the session in test teardown

## Typical test shape

```ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { makeTmpHome, cleanupTmpHome } from '../_test-helpers.ts';
import { stagePaginationFixture } from './manual-qa-followups.ts';
import { hasTmux, startTmuxE2E, TMUX_KEYS } from './tmux-e2e.ts';

const distPath = path.resolve('apps/ccaudit/dist/index.js');

describe.skipIf(process.platform === 'win32')('pagination TUI via tmux', () => {
  it('keeps picker alive after filtering and Esc clearing', async () => {
    if (!(await hasTmux())) return;

    const tmpHome = await makeTmpHome();
    try {
      await stagePaginationFixture(tmpHome, 550);
      const session = await startTmuxE2E({
        name: `ccaudit-pag-${Date.now()}`,
        tmpDir: tmpHome,
        cwd: process.cwd(),
        width: 120,
        height: 30,
        command: [process.execPath, distPath, 'ghost', '-i'],
        env: {
          HOME: tmpHome,
          USERPROFILE: tmpHome,
          XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
          TZ: 'UTC',
        },
      });

      try {
        await session.waitForText('AGENTS (0/550)');
        await session.sendKeys(
          Array.from({ length: 80 }, () => TMUX_KEYS.down),
          { delayMs: 5 },
        );
        await session.sendKeys(['/']);
        await session.sendLiteral('agent-09');
        await session.sendKeys([TMUX_KEYS.enter]);
        await session.waitForText('Filtered: 10 of 550 visible');
        await session.sendKeys([TMUX_KEYS.escape]);
        expect(await session.isAlive()).toBe(true);
      } finally {
        await session.kill();
      }
    } finally {
      await cleanupTmpHome(tmpHome);
    }
  });
});
```

## Recommended coverage from manual QA

Use this helper with `manual-qa-followups.ts` to automate:

| Manual row                 | Fixture                                | tmux action                                                                              |
| -------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| Phase 9 D1/D2              | `stagePaginationFixture(tmpHome, 550)` | Scroll, filter, Esc clear, sort.                                                         |
| Phase 9 E1/E4              | `stageGlyphFixture(tmpHome)`           | Capture glyph rows, press `?`, assert legend text.                                       |
| Phase 9 F1 partial         | any non-empty picker fixture           | `session.resize(width, height)` to simulate SIGWINCH. Still keep Terminal.app manual QA. |
| Phase 9 H2                 | `stageInteractiveBustFixture(tmpHome)` | Select item, confirm archive, then run non-interactive restore.                          |
| Phase 8/8.1 restore picker | existing restore-interactive fixture   | Tab to MEMORY, select, confirm/cancel.                                                   |

## Claude Code preflight note

Interactive archive flows run the same safety preflight as the real CLI. If a
fixture/test does **not** install and prepend the fake `ps` shim, then any open
Claude Code process can make the archive confirmation path refuse to mutate.

For automated temp-HOME tests, prefer `stageInteractiveBustFixture(tmpHome)` from
`manual-qa-followups.ts`; it installs `<tmpHome>/bin/ps`. The test must prepend
that directory to `PATH` when calling `startTmuxE2E()`:

```ts
env: {
  HOME: tmpHome,
  USERPROFILE: tmpHome,
  XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
  PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}`,
}
```

For manual tests against a real HOME / real PATH, close all Claude Code
instances first. Do not bypass the preflight outside disposable fixtures.

## Limits

This helper does **not** prove:

- macOS Terminal.app physical drag-resize behavior
- Cmd-+/Cmd-- font-size changes
- green-dot maximize behavior
- GitHub README table rendering in a browser

Those remain human QA rows.

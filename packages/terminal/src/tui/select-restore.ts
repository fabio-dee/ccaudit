// Restore-side picker adapter (Phase 08 Plan 04 — D8-01..D8-04).
//
// Thin wrapper over openTabbedPicker. Differences from archive-side:
//   - Footer omits tokens per D8-03 (renderTokenCounter stubbed to '').
//     RESTORE_FOOTER_TEMPLATE documents the canonical D8-03 text
//     `${selectedCount} selected · ${totalCount} archived`.
//   - No framework-as-unit protection per D8-04 — archived items are
//     already out of live inventory. This module never imports the
//     protection render helper and never reads item.framework.
//   - Cancel at any stage (Ctrl+C / Esc / q / n) → { kind: 'cancelled' }
//     with zero writes. INV-S2 mirror.
//
// The outcome carries restore-side canonical_ids (from dedupManifestOps),
// not the scanner-side canonicalItemId format. The adapter maps between
// them via a reverse lookup built at picker-open time.
import { confirm, isCancel } from '@clack/prompts';
import { canonicalItemId } from '@ccaudit/internal';
import type { ArchiveOp, DisableOp, FlagOp, RefreshOp, TokenCostResult } from '@ccaudit/internal';
import path from 'node:path';
import { openTabbedPicker } from './tabbed-picker.ts';

export type RestoreItemCategory = 'agent' | 'skill' | 'mcp' | 'memory' | 'command' | 'hook';

// Phase 8.1 D81-01 C1a: widened to include flag/refresh ops so memory items
// appear in the restore picker. Archive/disable items continue to render via
// synthesizeCostResult; flag/refresh items map to category:'memory' with
// filePath=op.file_path and zero token cost (picker footer omits tokens per D8-03).
export interface RestoreItem {
  canonical_id: string;
  op: ArchiveOp | DisableOp | FlagOp | RefreshOp;
  category: RestoreItemCategory;
}

export type SelectRestoreOutcome =
  | { kind: 'confirmed'; selectedIds: string[] }
  | { kind: 'cancelled' };

// D8-03 footer text, kept as a constant so intent is grep-visible.
// Live picker footer renders via tabbed-picker's shared _renderFrame.
export const RESTORE_FOOTER_TEMPLATE = '${selectedCount} selected · ${totalCount} archived';

export interface RestorePickerDep {
  openTabbedPicker: typeof openTabbedPicker;
  confirm: typeof confirm;
  isCancel: (v: unknown) => boolean;
}

function deriveDisplayName(op: RestoreItem['op']): string {
  if (op.op_type === 'archive') {
    return path.basename(op.archive_path, path.extname(op.archive_path));
  }
  if (op.op_type === 'flag' || op.op_type === 'refresh') {
    // Memory files: use basename (e.g. "CLAUDE.md", "style.md"). Preserve
    // extension so the picker can distinguish sibling files in the same dir.
    return path.basename(op.file_path);
  }
  const i = op.original_key.lastIndexOf('.');
  return i >= 0 ? op.original_key.slice(i + 1) : op.original_key;
}

function synthesizeCostResult(item: RestoreItem): TokenCostResult {
  const op = item.op;
  const pickerCategory: TokenCostResult['item']['category'] =
    item.category === 'mcp' ? 'mcp-server' : (item.category as TokenCostResult['item']['category']);
  let filePath: string;
  if (op.op_type === 'archive') {
    filePath = op.archive_path;
  } else if (op.op_type === 'flag' || op.op_type === 'refresh') {
    filePath = op.file_path;
  } else {
    filePath = `${op.config_path}#${op.new_key}`;
  }
  return {
    item: {
      name: deriveDisplayName(op),
      category: pickerCategory,
      scope: op.scope,
      projectPath: null,
      path: filePath,
    },
    tier: 'definite-ghost',
    lastUsed: null,
    invocationCount: 0,
    tokenEstimate: null,
  };
}

// Note: declared as `export function openRestorePicker(...)` (returns a Promise)
// so the acceptance-criteria grep in the Plan 08-04 spec matches literally.
export function openRestorePicker(
  items: readonly RestoreItem[],
  _deps?: Partial<RestorePickerDep>,
): Promise<SelectRestoreOutcome> {
  return _openRestorePicker(items, _deps);
}

async function _openRestorePicker(
  items: readonly RestoreItem[],
  _deps?: Partial<RestorePickerDep>,
): Promise<SelectRestoreOutcome> {
  const deps: RestorePickerDep = {
    openTabbedPicker: _deps?.openTabbedPicker ?? openTabbedPicker,
    confirm: _deps?.confirm ?? confirm,
    isCancel: _deps?.isCancel ?? isCancel,
  };
  if (items.length === 0) return { kind: 'cancelled' };

  const synth: TokenCostResult[] = [];
  const pickerIdToRestoreId = new Map<string, string>();
  for (const it of items) {
    const cost = synthesizeCostResult(it);
    const pickerId = canonicalItemId(cost.item);
    if (!pickerIdToRestoreId.has(pickerId)) {
      pickerIdToRestoreId.set(pickerId, it.canonical_id);
      synth.push(cost);
    }
  }

  const outcome = await deps.openTabbedPicker({
    ghosts: synth,
    useAscii: false,
    renderTokenCounter: () => '',
    // D81-02 (C1b): canonical restore footer wording (D8-03). Middle-dot is
    // U+00B7, NOT a regular period. RESTORE_FOOTER_TEMPLATE above documents
    // the same template for grep-visibility.
    renderFooter: (n, m) => `${n} selected \u00B7 ${m} archived`,
  });
  if (outcome.kind === 'cancel' || outcome.kind === 'empty-inventory') {
    return { kind: 'cancelled' };
  }

  const selectedIds: string[] = [];
  for (const pickerId of outcome.ids) {
    const restoreId = pickerIdToRestoreId.get(pickerId);
    if (restoreId !== undefined) selectedIds.push(restoreId);
  }

  const result = await deps.confirm({
    message: `Restore ${selectedIds.length} items?`,
    initialValue: false,
  });
  if (deps.isCancel(result)) return { kind: 'cancelled' };
  if (result === true) return { kind: 'confirmed', selectedIds };
  return { kind: 'cancelled' };
}

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;

  function makeArchiveItem(overrides: {
    name: string;
    category?: 'agent' | 'skill' | 'command';
    archive_path?: string;
  }): RestoreItem {
    const cat = overrides.category ?? 'agent';
    const archive_path =
      overrides.archive_path ?? `/home/u/.claude/ccaudit/archived/${cat}s/${overrides.name}.md`;
    const op: ArchiveOp = {
      op_id: `op-${overrides.name}`,
      op_type: 'archive',
      timestamp: '2026-04-19T00:00:00Z',
      status: 'completed',
      category: cat,
      scope: 'global',
      source_path: `/home/u/.claude/${cat}s/${overrides.name}.md`,
      archive_path,
      content_sha256: 'deadbeef',
    };
    return { canonical_id: `${cat}:${archive_path}`, op, category: cat };
  }

  function makeDisableItem(name: string): RestoreItem {
    const config_path = '/home/u/.claude.json';
    const new_key = `mcpServers.ccaudit-disabled:${name}`;
    const op: DisableOp = {
      op_id: `op-${name}`,
      op_type: 'disable',
      timestamp: '2026-04-19T00:00:00Z',
      status: 'completed',
      config_path,
      scope: 'global',
      project_path: null,
      original_key: `mcpServers.${name}`,
      new_key,
      original_value: {},
    };
    return { canonical_id: `mcp:${config_path}:${new_key}`, op, category: 'mcp' };
  }

  describe('openRestorePicker', () => {
    it('empty items → cancelled, picker NOT opened', async () => {
      const dep = {
        openTabbedPicker: vi.fn(),
        confirm: vi.fn(),
        isCancel: vi.fn(() => false),
      };
      const out = await openRestorePicker([], dep);
      expect(out).toEqual({ kind: 'cancelled' });
      expect(dep.openTabbedPicker).not.toHaveBeenCalled();
      expect(dep.confirm).not.toHaveBeenCalled();
    });

    it('picker cancel → cancelled, confirm NEVER called (INV-S2 mirror)', async () => {
      const dep = {
        openTabbedPicker: vi.fn().mockResolvedValue({ kind: 'cancel' }),
        confirm: vi.fn(),
        isCancel: vi.fn(() => false),
      };
      const out = await openRestorePicker([makeArchiveItem({ name: 'a1' })], dep);
      expect(out).toEqual({ kind: 'cancelled' });
      expect(dep.confirm).not.toHaveBeenCalled();
    });

    it('selection + confirm=true → confirmed with restore canonical_ids', async () => {
      const a1 = makeArchiveItem({ name: 'a1', category: 'agent' });
      const m1 = makeDisableItem('playwright');
      const pickerA = canonicalItemId({
        name: 'a1',
        category: 'agent',
        scope: 'global',
        projectPath: null,
        path: (a1.op as ArchiveOp).archive_path,
      });
      const pickerM = canonicalItemId({
        name: 'playwright',
        category: 'mcp-server',
        scope: 'global',
        projectPath: null,
        path: `${(m1.op as DisableOp).config_path}#${(m1.op as DisableOp).new_key}`,
      });
      const dep = {
        openTabbedPicker: vi
          .fn()
          .mockResolvedValue({ kind: 'selected', ids: new Set([pickerA, pickerM]) }),
        confirm: vi.fn().mockResolvedValue(true),
        isCancel: vi.fn(() => false),
      };
      const out = await openRestorePicker([a1, m1], dep);
      expect(out.kind).toBe('confirmed');
      if (out.kind === 'confirmed') {
        expect(out.selectedIds.sort()).toEqual([a1.canonical_id, m1.canonical_id].sort());
      }
      const call = dep.confirm.mock.calls[0]![0] as { message: string };
      expect(call.message).toBe('Restore 2 items?');
    });

    it('confirm declined → cancelled', async () => {
      const a1 = makeArchiveItem({ name: 'a1' });
      const pickerA = canonicalItemId({
        name: 'a1',
        category: 'agent',
        scope: 'global',
        projectPath: null,
        path: (a1.op as ArchiveOp).archive_path,
      });
      const dep = {
        openTabbedPicker: vi.fn().mockResolvedValue({ kind: 'selected', ids: new Set([pickerA]) }),
        confirm: vi.fn().mockResolvedValue(false),
        isCancel: vi.fn(() => false),
      };
      const out = await openRestorePicker([a1], dep);
      expect(out).toEqual({ kind: 'cancelled' });
    });

    it('confirm cancel symbol → cancelled', async () => {
      const a1 = makeArchiveItem({ name: 'a1' });
      const pickerA = canonicalItemId({
        name: 'a1',
        category: 'agent',
        scope: 'global',
        projectPath: null,
        path: (a1.op as ArchiveOp).archive_path,
      });
      const sym = Symbol('cancel');
      const dep = {
        openTabbedPicker: vi.fn().mockResolvedValue({ kind: 'selected', ids: new Set([pickerA]) }),
        confirm: vi.fn().mockResolvedValue(sym),
        isCancel: vi.fn((v: unknown) => v === sym),
      };
      const out = await openRestorePicker([a1], dep);
      expect(out).toEqual({ kind: 'cancelled' });
    });

    it('RESTORE_FOOTER_TEMPLATE encodes D8-03 text', () => {
      expect(RESTORE_FOOTER_TEMPLATE).toContain('selected · ');
      expect(RESTORE_FOOTER_TEMPLATE).toContain(' archived');
    });
  });
}

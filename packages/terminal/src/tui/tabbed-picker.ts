/**
 * TabbedGhostPicker (D3.1-14) — custom @clack/core.MultiSelectPrompt subclass
 * that replaces Phase 2's flat groupMultiselect with a tabbed category view.
 *
 * Motivation: Phase 2's groupMultiselect has no windowing — when ghosts.length
 * exceeds terminal rows, the cursor scrolls off-screen. This subclass splits
 * ghosts into one tab per non-empty category (D3.1-04), with a bounded viewport
 * per tab (D3.1-05: `Math.max(8, (stdout.rows ?? 24) - 10)`) so long lists are
 * structurally impossible to render past the terminal.
 *
 * Decisions implemented here: D3.1-01 (Tab + Shift-Tab + ← → cycle tabs),
 * D3.1-02 (1–6 re-indexed over visible tabs), D3.1-03 (wrap), D3.1-04 (empty
 * hidden), D3.1-05 (viewport formula), D3.1-06 (↑/↓ N more indicators),
 * D3.1-07 (PageUp/PageDown/Home/End scoped to active tab), D3.1-08 (per-tab
 * cursor memory), D3.1-09 (tab bar + per-tab header), D3.1-11 (compact hint),
 * D3.1-12 (renderTokenCounter stub for Phase 4 handshake), D3.1-15 (cross-tab
 * Set<string> selection; a scoped to active tab only).
 *
 * Plan 03 will wire this into select-ghosts.ts as a thin adapter. This plan
 * does NOT modify select-ghosts.ts — the class and openTabbedPicker helper
 * live here standalone.
 */
import { MultiSelectPrompt, isCancel } from '@clack/core';
import { canonicalItemId } from '@ccaudit/internal';
import type { TokenCostResult } from '@ccaudit/internal';
import pc from 'picocolors';
import { computeViewportHeight, windowRows } from './_viewport.ts';
import { renderTabBar, type TabDescriptor } from './_tab-bar.ts';
import { CATEGORY_ORDER, CATEGORY_LABEL, formatRowLabel } from './select-ghosts.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TabbedPickerInput {
  /** Items already filtered to ghost tier by caller. */
  ghosts: readonly TokenCostResult[];
  /** From shouldUseAscii() at CLI entry (D-16 invariant). */
  useAscii: boolean;
  /** Injected for testability — defaults to Date.now(). */
  now?: number;
  /** Injected for testability — defaults to process.stdout.rows. */
  stdoutRows?: number;
  /** Injected for testability — defaults to process.stdout.columns ?? 80. */
  terminalCols?: number;
  /** Test escape hatch: force a specific viewport height regardless of stdoutRows. */
  viewportHeightOverride?: number;
  /** Phase 4 handshake (D3.1-12): footer-slot renderer. Returns '' this phase. */
  renderTokenCounter?: () => string;
}

export type TabbedPickerOutcome =
  | { kind: 'selected'; ids: Set<string> }
  | { kind: 'cancel' }
  | { kind: 'empty-inventory' };

// Internal per-tab state.
interface TabState {
  categoryId: string;
  label: string;
  items: TokenCostResult[];
  cursor: number;
}

// Option shape for @clack/core.MultiSelectPrompt<T>.
interface FlatOption {
  value: string;
  label: string;
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// TabbedGhostPicker class
// ---------------------------------------------------------------------------

export class TabbedGhostPicker extends MultiSelectPrompt<FlatOption> {
  public tabs: TabState[];
  public activeTabIndex = 0;
  public selectedIds: Set<string>;
  public useAscii: boolean;
  public renderTokenCounter: () => string;
  private viewportHeightOverride?: number;
  private now: number;
  private stdoutRows?: number;
  private terminalCols: number;

  constructor(input: TabbedPickerInput) {
    // Partition ghosts into per-category tabs (CATEGORY_ORDER) with descending
    // token sort (D-12). Empty categories are dropped (D3.1-04).
    const grouped: Record<string, TokenCostResult[]> = {};
    for (const cat of CATEGORY_ORDER) grouped[cat] = [];
    for (const g of input.ghosts) {
      const cat = g.item.category;
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(g);
    }
    for (const cat of CATEGORY_ORDER) {
      grouped[cat]!.sort((a, b) => (b.tokenEstimate?.tokens ?? 0) - (a.tokenEstimate?.tokens ?? 0));
    }
    const tabs: TabState[] = [];
    for (const cat of CATEGORY_ORDER) {
      const items = grouped[cat]!;
      if (items.length === 0) continue;
      tabs.push({
        categoryId: cat,
        label: CATEGORY_LABEL[cat] ?? cat.toUpperCase(),
        items,
        cursor: 0,
      });
    }
    if (tabs.length === 0) {
      throw new Error('TabbedGhostPicker: no non-empty categories; caller must short-circuit');
    }

    // Build flat options array for MultiSelectPrompt's contract.
    // We override render() below so this array is never displayed flat — but
    // the base class inspects .length and cursor, so it must be populated.
    const now = input.now ?? Date.now();
    const useAscii = input.useAscii;
    const flatOptions: FlatOption[] = [];
    for (const tab of tabs) {
      for (const item of tab.items) {
        flatOptions.push({
          value: canonicalItemId(item.item),
          label: formatRowLabel(item, useAscii, now),
        });
      }
    }

    super({
      options: flatOptions,
      required: false,
      render() {
        // Delegate to the instance method; `this` is the Prompt instance.
        // Cast because render() returns string | undefined.
        return (this as unknown as TabbedGhostPicker)._renderFrame();
      },
    });

    this.tabs = tabs;
    this.selectedIds = new Set<string>();
    this.useAscii = useAscii;
    this.now = now;
    this.stdoutRows = input.stdoutRows;
    this.terminalCols = input.terminalCols ?? 80;
    this.renderTokenCounter = input.renderTokenCounter ?? (() => '');
    this.viewportHeightOverride = input.viewportHeightOverride;

    // Key dispatch: char-based keys + modifier-based tab switching.
    // info.name is a node:readline Key.name (e.g. 'tab', 'pageup', 'home').
    // The base class auto-calls render() after every keypress, so mutating
    // instance state here is sufficient — no explicit render call needed.
    this.on('key', (char, info) => {
      // Tab switching: Tab / Shift-Tab.
      if (info?.name === 'tab') {
        if (info.shift === true) this.prevTab();
        else this.nextTab();
        return;
      }
      // Page / Home / End — scoped to active tab (D3.1-07).
      if (info?.name === 'pageup') {
        this.cursorPageUp();
        return;
      }
      if (info?.name === 'pagedown') {
        this.cursorPageDown();
        return;
      }
      if (info?.name === 'home') {
        this.cursorHome();
        return;
      }
      if (info?.name === 'end') {
        this.cursorEnd();
        return;
      }
      // q — cancel alias (Esc / Ctrl-C handled by base via default aliases).
      if (char === 'q') {
        this.cancel();
        return;
      }
      // a — toggle-all-in-active-tab (D3.1-15; overrides base class's toggleAll).
      if (char === 'a') {
        this.toggleAllInActiveTab();
        return;
      }
      // Numeric 1..6 — jump to visible tab index N-1 (D3.1-02).
      if (
        char === '1' ||
        char === '2' ||
        char === '3' ||
        char === '4' ||
        char === '5' ||
        char === '6'
      ) {
        const idx = parseInt(char, 10) - 1;
        this.jumpToTab(idx);
        return;
      }
    });

    // Cursor dispatch: arrow keys + space + enter + cancel (via base aliases).
    // 'left'/'right' also cycle tabs (D3.1-01), matching Tab/Shift-Tab.
    this.on('cursor', (action) => {
      if (action === 'up') this.cursorUp();
      else if (action === 'down') this.cursorDown();
      else if (action === 'left') this.prevTab();
      else if (action === 'right') this.nextTab();
      else if (action === 'space') this.toggleCurrentRow();
      else if (action === 'enter') this.submit();
      else if (action === 'cancel') this.cancel();
      // Mirror the active tab's cursor onto the base class's cursor for any
      // internal consistency checks (though render() is fully overridden).
      this.cursor = this.tabs[this.activeTabIndex]?.cursor ?? 0;
    });
  }

  // ---------------------------------------------------------------------------
  // Tab navigation
  // ---------------------------------------------------------------------------

  public nextTab(): void {
    this.activeTabIndex = (this.activeTabIndex + 1) % this.tabs.length;
  }

  public prevTab(): void {
    this.activeTabIndex = (this.activeTabIndex - 1 + this.tabs.length) % this.tabs.length;
  }

  public jumpToTab(index: number): void {
    if (index < 0 || index >= this.tabs.length) return; // no-op (D3.1-02)
    this.activeTabIndex = index;
  }

  // ---------------------------------------------------------------------------
  // Cursor navigation within active tab
  // ---------------------------------------------------------------------------

  private activeTab(): TabState {
    return this.tabs[this.activeTabIndex]!;
  }

  public cursorUp(): void {
    const t = this.activeTab();
    t.cursor = Math.max(0, t.cursor - 1);
  }

  public cursorDown(): void {
    const t = this.activeTab();
    t.cursor = Math.min(t.items.length - 1, t.cursor + 1);
  }

  public cursorPageUp(): void {
    const t = this.activeTab();
    const vh = computeViewportHeight({
      rowsOverride: this.viewportHeightOverride,
      stdoutRows: this.stdoutRows,
    });
    t.cursor = Math.max(0, t.cursor - vh);
  }

  public cursorPageDown(): void {
    const t = this.activeTab();
    const vh = computeViewportHeight({
      rowsOverride: this.viewportHeightOverride,
      stdoutRows: this.stdoutRows,
    });
    t.cursor = Math.min(t.items.length - 1, t.cursor + vh);
  }

  public cursorHome(): void {
    this.activeTab().cursor = 0;
  }

  public cursorEnd(): void {
    const t = this.activeTab();
    t.cursor = t.items.length - 1;
  }

  // ---------------------------------------------------------------------------
  // Selection operations
  // ---------------------------------------------------------------------------

  public toggleCurrentRow(): void {
    const t = this.activeTab();
    const item = t.items[t.cursor];
    if (!item) return;
    const id = canonicalItemId(item.item);
    if (this.selectedIds.has(id)) this.selectedIds.delete(id);
    else this.selectedIds.add(id);
  }

  /**
   * D3.1-15: `a` scope is active tab only in v0.5. If every item in the active
   * tab is already selected, deselect them all; otherwise select them all.
   */
  public toggleAllInActiveTab(): void {
    const t = this.activeTab();
    const ids = t.items.map((i) => canonicalItemId(i.item));
    const allSelected = ids.every((id) => this.selectedIds.has(id));
    if (allSelected) {
      for (const id of ids) this.selectedIds.delete(id);
    } else {
      for (const id of ids) this.selectedIds.add(id);
    }
  }

  // ---------------------------------------------------------------------------
  // Submit / cancel
  // ---------------------------------------------------------------------------

  public submit(): void {
    // Mirror selectedIds Set into the base-class value array so consumers
    // of this.value (if any) see the selection.
    this.value = Array.from(this.selectedIds);
    this.state = 'submit';
  }

  public cancel(): void {
    this.state = 'cancel';
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  public _renderFrame(): string {
    const lines: string[] = [];
    const t = this.activeTab();

    // 1. Tab bar.
    const tabDescriptors: TabDescriptor[] = this.tabs.map((tab) => ({ label: tab.label }));
    lines.push(
      renderTabBar({
        tabs: tabDescriptors,
        activeIndex: this.activeTabIndex,
        useAscii: this.useAscii,
        terminalCols: this.terminalCols,
      }),
    );

    // 2. Per-tab header: `{label} (N/M)` (D3.1-09 / SC3).
    const selectedInTab = t.items.filter((i) =>
      this.selectedIds.has(canonicalItemId(i.item)),
    ).length;
    const totalInTab = t.items.length;
    lines.push(pc.bold(`${t.label} (${selectedInTab}/${totalInTab})`));

    // 3–5. Viewport window + ↑/↓ N more indicators (D3.1-06).
    const vh = computeViewportHeight({
      rowsOverride: this.viewportHeightOverride,
      stdoutRows: this.stdoutRows,
    });
    const win = windowRows({ rows: t.items, cursor: t.cursor, viewportHeight: vh });

    if (win.aboveCount > 0) {
      const up = this.useAscii ? '^' : '↑';
      lines.push(pc.dim(`${up} ${win.aboveCount} more above`));
    }

    const cursorGlyph = this.useAscii ? '>' : '›';
    for (let i = 0; i < win.slice.length; i++) {
      const absIdx = win.sliceStart + i;
      const item = win.slice[i]!;
      const id = canonicalItemId(item.item);
      const isCursor = absIdx === t.cursor;
      const isSelected = this.selectedIds.has(id);
      const marker = isSelected ? '[x]' : '[ ]';
      const cursorMark = isCursor ? cursorGlyph : ' ';
      const label = formatRowLabel(item, this.useAscii, this.now);
      lines.push(`${cursorMark} ${marker} ${label}`);
    }

    if (win.belowCount > 0) {
      const down = this.useAscii ? 'v' : '↓';
      lines.push(pc.dim(`${down} ${win.belowCount} more below`));
    }

    // 6. Compact hint (D3.1-11).
    const leftArrow = this.useAscii ? '<-' : '←';
    const rightArrow = this.useAscii ? '->' : '→';
    const upArrow = this.useAscii ? '^' : '↑';
    const downArrow = this.useAscii ? 'v' : '↓';
    const dot = this.useAscii ? '|' : '·';
    lines.push(
      pc.dim(
        `Tab ${leftArrow} ${rightArrow} tabs ${dot} ${upArrow}${downArrow} nav ${dot} Space toggle ${dot} a tab-all ${dot} Enter ${rightArrow} ${dot} q cancel`,
      ),
    );

    // 7. Global count line (D3.1-10).
    const totalItems = this.tabs.reduce((sum, tab) => sum + tab.items.length, 0);
    lines.push(`${this.selectedIds.size} of ${totalItems} selected across all tabs`);

    // 8. Footer token-counter slot (D3.1-12 — Phase 4 handshake).
    // Always call renderTokenCounter so the layout preserves its line slot.
    // In this phase it returns '' — Phase 4 replaces the stub implementation.
    const footer = this.renderTokenCounter();
    if (footer !== '') lines.push(footer);

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// openTabbedPicker helper
// ---------------------------------------------------------------------------

/**
 * Opens the tabbed picker for the provided ghost items.
 *
 * Returns:
 *  - { kind: 'empty-inventory' } if ghosts.length === 0 (no prompt opened)
 *  - { kind: 'cancel' }          if user pressed Ctrl+C / Esc / q
 *  - { kind: 'selected', ids }   on Enter with 0..N items selected
 */
export async function openTabbedPicker(input: TabbedPickerInput): Promise<TabbedPickerOutcome> {
  // D-13: Empty state — caller should skip picker entirely (matches Phase 2).
  if (input.ghosts.length === 0) {
    return { kind: 'empty-inventory' };
  }

  const picker = new TabbedGhostPicker(input);
  const result = await picker.prompt();

  if (isCancel(result)) {
    return { kind: 'cancel' };
  }
  // When the user submits, picker.selectedIds holds the canonical source of truth.
  return { kind: 'selected', ids: new Set(picker.selectedIds) };
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  /** Minimal TokenCostResult factory. */
  function makeGhost(overrides: {
    name: string;
    category?: string;
    path?: string;
    tokens?: number;
    mtimeMs?: number;
  }): TokenCostResult {
    return {
      item: {
        name: overrides.name,
        category: (overrides.category ?? 'agent') as TokenCostResult['item']['category'],
        scope: 'global',
        projectPath: null,
        path: overrides.path ?? `/fake/${overrides.name}`,
        ...(overrides.mtimeMs !== undefined ? { mtimeMs: overrides.mtimeMs } : {}),
      },
      tier: 'definite-ghost',
      lastUsed: null,
      invocationCount: 0,
      tokenEstimate:
        overrides.tokens !== undefined
          ? { tokens: overrides.tokens, confidence: 'estimated', source: 'test' }
          : null,
    };
  }

  /**
   * Build a picker instance without invoking .prompt() — construction only
   * touches the base class's input/output stream setup; the readline
   * interface is created lazily inside prompt(). So constructing is safe.
   */
  function makePicker(
    ghostsOrInput: readonly TokenCostResult[] | TabbedPickerInput,
  ): TabbedGhostPicker {
    const input: TabbedPickerInput = Array.isArray(ghostsOrInput)
      ? { ghosts: ghostsOrInput, useAscii: true, stdoutRows: 24, terminalCols: 120 }
      : (ghostsOrInput as TabbedPickerInput);
    return new TabbedGhostPicker(input);
  }

  describe('TabbedGhostPicker', () => {
    it('Test 1: constructor partitions three categories into three tabs with correct labels', () => {
      const ghosts = [
        makeGhost({ name: 'a1', category: 'agent', tokens: 100 }),
        makeGhost({ name: 's1', category: 'skill', tokens: 200 }),
        makeGhost({ name: 'h1', category: 'hook', tokens: 50 }),
      ];
      const picker = makePicker(ghosts);
      expect(picker.tabs.length).toBe(3);
      // CATEGORY_ORDER is agent, skill, mcp-server, memory, command, hook — so
      // the three non-empty categories render in that order.
      expect(picker.tabs[0]!.label).toBe('AGENTS');
      expect(picker.tabs[1]!.label).toBe('SKILLS');
      expect(picker.tabs[2]!.label).toBe('HOOKS');
    });

    it('Test 2: empty categories are dropped (input has 6 requested cats but only 3 have items)', () => {
      // Include items in only 3 of the 6 categories.
      const ghosts = [
        makeGhost({ name: 'a1', category: 'agent', tokens: 100 }),
        makeGhost({ name: 'mcp1', category: 'mcp-server', tokens: 500 }),
        makeGhost({ name: 'cmd1', category: 'command', tokens: 30 }),
      ];
      const picker = makePicker(ghosts);
      expect(picker.tabs.length).toBe(3);
      const ids = picker.tabs.map((t) => t.categoryId);
      expect(ids).toEqual(['agent', 'mcp-server', 'command']);
    });

    it('Test 3: Space toggles current row canonical ID in selectedIds', () => {
      const ghost = makeGhost({ name: 'only', category: 'agent', tokens: 100 });
      const picker = makePicker([ghost]);
      expect(picker.selectedIds.size).toBe(0);
      picker.toggleCurrentRow();
      expect(picker.selectedIds.size).toBe(1);
      const expectedId = 'agent|global||/fake/only';
      expect(picker.selectedIds.has(expectedId)).toBe(true);
      // Second toggle deselects.
      picker.toggleCurrentRow();
      expect(picker.selectedIds.size).toBe(0);
    });

    it("Test 4: 'a' toggles all items in active tab only (items in other tabs untouched)", () => {
      const ghosts = [
        makeGhost({ name: 'a1', category: 'agent', tokens: 100 }),
        makeGhost({ name: 'a2', category: 'agent', tokens: 80 }),
        makeGhost({ name: 's1', category: 'skill', tokens: 200 }),
        makeGhost({ name: 's2', category: 'skill', tokens: 150 }),
      ];
      const picker = makePicker(ghosts);
      // activeTabIndex = 0 → AGENTS. Toggle-all should select both agents only.
      picker.toggleAllInActiveTab();
      expect(picker.selectedIds.size).toBe(2);
      expect(picker.selectedIds.has('agent|global||/fake/a1')).toBe(true);
      expect(picker.selectedIds.has('agent|global||/fake/a2')).toBe(true);
      expect(picker.selectedIds.has('skill|global||/fake/s1')).toBe(false);
      expect(picker.selectedIds.has('skill|global||/fake/s2')).toBe(false);
      // Toggle again → all deselected in active tab.
      picker.toggleAllInActiveTab();
      expect(picker.selectedIds.size).toBe(0);
    });

    it('Test 5: Tab increments activeTabIndex with wrap (after last tab → 0)', () => {
      const ghosts = [
        makeGhost({ name: 'a1', category: 'agent', tokens: 100 }),
        makeGhost({ name: 's1', category: 'skill', tokens: 200 }),
        makeGhost({ name: 'h1', category: 'hook', tokens: 50 }),
      ];
      const picker = makePicker(ghosts);
      expect(picker.activeTabIndex).toBe(0);
      picker.nextTab();
      expect(picker.activeTabIndex).toBe(1);
      picker.nextTab();
      expect(picker.activeTabIndex).toBe(2);
      picker.nextTab();
      expect(picker.activeTabIndex).toBe(0); // wrapped
    });

    it('Test 6: Shift-Tab wraps backwards (from index 0 → last)', () => {
      const ghosts = [
        makeGhost({ name: 'a1', category: 'agent', tokens: 100 }),
        makeGhost({ name: 's1', category: 'skill', tokens: 200 }),
        makeGhost({ name: 'h1', category: 'hook', tokens: 50 }),
      ];
      const picker = makePicker(ghosts);
      expect(picker.activeTabIndex).toBe(0);
      picker.prevTab();
      expect(picker.activeTabIndex).toBe(2); // wrapped to last
      picker.prevTab();
      expect(picker.activeTabIndex).toBe(1);
    });

    it("Test 7: numeric '1' → index 0; '4' with only 3 tabs → no-op", () => {
      const ghosts = [
        makeGhost({ name: 'a1', category: 'agent', tokens: 100 }),
        makeGhost({ name: 's1', category: 'skill', tokens: 200 }),
        makeGhost({ name: 'h1', category: 'hook', tokens: 50 }),
      ];
      const picker = makePicker(ghosts);
      picker.nextTab(); // move off default 0
      expect(picker.activeTabIndex).toBe(1);
      picker.jumpToTab(0); // '1'
      expect(picker.activeTabIndex).toBe(0);
      picker.jumpToTab(3); // '4' — out of range, no-op
      expect(picker.activeTabIndex).toBe(0);
      picker.jumpToTab(2); // '3'
      expect(picker.activeTabIndex).toBe(2);
    });

    it('Test 8: per-tab cursor preserved — set cursor in tab 0, switch away, switch back → restored', () => {
      const ghosts = [
        makeGhost({ name: 'a1', category: 'agent', tokens: 100 }),
        makeGhost({ name: 'a2', category: 'agent', tokens: 90 }),
        makeGhost({ name: 'a3', category: 'agent', tokens: 80 }),
        makeGhost({ name: 's1', category: 'skill', tokens: 200 }),
        makeGhost({ name: 's2', category: 'skill', tokens: 150 }),
      ];
      const picker = makePicker(ghosts);
      // activeTabIndex=0 (AGENTS). Move cursor to row 2.
      picker.cursorDown();
      picker.cursorDown();
      expect(picker.tabs[0]!.cursor).toBe(2);
      // Switch to tab 1 (SKILLS). Its cursor starts at 0.
      picker.nextTab();
      expect(picker.activeTabIndex).toBe(1);
      expect(picker.tabs[1]!.cursor).toBe(0);
      // Move cursor in SKILLS to row 1.
      picker.cursorDown();
      expect(picker.tabs[1]!.cursor).toBe(1);
      // Switch back to AGENTS → its cursor is still 2.
      picker.prevTab();
      expect(picker.activeTabIndex).toBe(0);
      expect(picker.tabs[0]!.cursor).toBe(2);
    });

    it('openTabbedPicker empty-inventory short-circuits without constructing picker', async () => {
      const result = await openTabbedPicker({ ghosts: [], useAscii: true });
      expect(result.kind).toBe('empty-inventory');
    });

    it('cross-tab selection persists across tab navigation (both ArrowRight/Left and Tab/Shift-Tab bindings)', () => {
      // Phase 3.1 Plan 04 Task 3 (SC2 + cross-tab state):
      // select 2 AGENTS → → (next tab) → select 1 SKILL → ← (prev tab) →
      // all 3 canonical IDs survive in selectedIds. Repeat with Tab/Shift-Tab
      // → identical final state.
      //
      // The class dispatches `Tab` key and `ArrowRight` cursor action to the
      // SAME method (nextTab), and `Shift-Tab` + `ArrowLeft` to prevTab. The
      // binding equivalence is structural in the constructor's key/cursor
      // dispatch; this test confirms the observable invariant (final
      // selectedIds contents) is identical for both sequences.
      function buildFixture(): readonly TokenCostResult[] {
        return [
          makeGhost({ name: 'a1', category: 'agent', tokens: 100 }),
          makeGhost({ name: 'a2', category: 'agent', tokens: 80 }),
          makeGhost({ name: 's1', category: 'skill', tokens: 200 }),
          makeGhost({ name: 's2', category: 'skill', tokens: 150 }),
        ];
      }
      // Sequence A: ArrowRight / ArrowLeft (→ / ← bindings).
      {
        const picker = makePicker(buildFixture());
        expect(picker.tabs.length).toBe(2);
        // activeTabIndex=0 (AGENTS)
        picker.toggleCurrentRow(); // select a1 (top-of-tab)
        picker.cursorDown();
        picker.toggleCurrentRow(); // select a2
        picker.nextTab(); // → : ArrowRight binding
        expect(picker.activeTabIndex).toBe(1);
        picker.toggleCurrentRow(); // select s1 (top-of-tab 1)
        picker.prevTab(); // ← : ArrowLeft binding
        expect(picker.activeTabIndex).toBe(0);
        expect(picker.selectedIds.size).toBe(3);
        expect(picker.selectedIds.has('agent|global||/fake/a1')).toBe(true);
        expect(picker.selectedIds.has('agent|global||/fake/a2')).toBe(true);
        expect(picker.selectedIds.has('skill|global||/fake/s1')).toBe(true);
      }
      // Sequence B: Tab / Shift-Tab bindings.
      // nextTab/prevTab are the SAME methods Tab/Shift-Tab dispatch to —
      // the point of this block is the contract assertion that the final
      // selectedIds shape is identical across the two binding families.
      {
        const picker = makePicker(buildFixture());
        picker.toggleCurrentRow(); // select a1 via Space
        picker.cursorDown();
        picker.toggleCurrentRow(); // select a2 via Space
        picker.nextTab(); // Tab binding
        expect(picker.activeTabIndex).toBe(1);
        picker.toggleCurrentRow(); // select s1
        picker.prevTab(); // Shift-Tab binding
        expect(picker.activeTabIndex).toBe(0);
        expect(picker.selectedIds.size).toBe(3);
        expect(picker.selectedIds.has('agent|global||/fake/a1')).toBe(true);
        expect(picker.selectedIds.has('agent|global||/fake/a2')).toBe(true);
        expect(picker.selectedIds.has('skill|global||/fake/s1')).toBe(true);
      }
    });

    it('_renderFrame produces non-empty output with tab bar, header, rows, hints, and global count', () => {
      const ghosts = [
        makeGhost({ name: 'a1', category: 'agent', tokens: 100 }),
        makeGhost({ name: 's1', category: 'skill', tokens: 200 }),
      ];
      const picker = makePicker(ghosts);
      const frame = picker._renderFrame();
      // Tab bar contains both labels.
      expect(frame).toContain('AGENTS');
      expect(frame).toContain('SKILLS');
      // Per-tab header with 0/1 selection.
      expect(frame).toContain('AGENTS (0/1)');
      // Row contains the cursor glyph (we used useAscii=true in makePicker).
      expect(frame).toContain('>');
      expect(frame).toContain('[ ]');
      // Global count.
      expect(frame).toContain('0 of 2 selected across all tabs');
      // Hint line (ASCII arrows from useAscii=true).
      expect(frame).toContain('Tab');
      expect(frame).toContain('Space toggle');
      expect(frame).toContain('q cancel');
    });
  });
}

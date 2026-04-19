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
import { canonicalItemId, formatTokensApprox } from '@ccaudit/internal';
import type { TokenCostResult } from '@ccaudit/internal';
import pc from 'picocolors';
import { computeViewportHeight, windowRows } from './_viewport.ts';
import { renderTabBar, type TabDescriptor } from './_tab-bar.ts';
import { CATEGORY_ORDER, CATEGORY_LABEL, formatRowLabel } from './select-ghosts.ts';
import {
  matchesQuery,
  sortItems,
  nextSort,
  sanitizeFilterQuery,
  defaultFilterSortState,
  type FilterSortState,
} from './_filter-sort.ts';
import { renderHelpOverlay } from './_help-overlay.ts';

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
  public tokensById: Map<string, number>;
  public useAscii: boolean;
  public renderTokenCounter: () => string;
  public filterSortByTab: FilterSortState[];
  public filterMode = false;

  /**
   * Phase 5 D5-13: modal help overlay flag. When true, the picker swallows
   * every key except `?` (toggle off) and `Esc` (close); cursor actions are
   * also swallowed EXCEPT `cancel` (Ctrl+C), which must remain live to
   * preserve INV-S2 (see T-05-02 mitigation). Render branches on this flag
   * at the top of `_renderFrame()` and returns `renderHelpOverlay(...)`.
   */
  public helpOpen = false;
  private viewportHeightOverride?: number;
  private now: number;
  private stdoutRows?: number;
  private terminalCols: number;
  private _resizeHandler: (() => void) | null = null;
  private _resizeThrottleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(input: TabbedPickerInput) {
    // Partition ghosts into per-category tabs (CATEGORY_ORDER) with descending
    // token sort (D-12). Empty categories are dropped (D3.1-04).
    //
    // WR-02 exhaustiveness guard: refuse ghosts whose category is not in
    // CATEGORY_ORDER. The static TypeScript union rules this out today, but
    // relying on the union alone means a future domain-type expansion (or an
    // `as` cast upstream) would silently drop items from every tab — a
    // data-loss regression. Failing loud here surfaces the mismatch in tests
    // and during development.
    const grouped: Record<string, TokenCostResult[]> = {};
    for (const cat of CATEGORY_ORDER) grouped[cat] = [];
    const knownCategories = new Set<string>(CATEGORY_ORDER);
    for (const g of input.ghosts) {
      const cat = g.item.category;
      if (!knownCategories.has(cat)) {
        throw new Error(
          `TabbedGhostPicker: unknown category '${cat}' — update CATEGORY_ORDER in select-ghosts.ts`,
        );
      }
      // Phase 3.2 SC6: hooks are advisory-only until archival semantics are designed.
      // Skip them here so the HOOKS tab never appears in the picker. WR-02 exhaustiveness
      // guard still fires for any truly unknown category (checked above). Hooks stay in
      // the ghost report and in the token totals under --include-hooks.
      if (cat === 'hook') continue;
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
    this.filterSortByTab = tabs.map(() => defaultFilterSortState());
    // Phase 4 D4-01 / D4-12: pre-compute a tokens-by-canonical-id map once at
    // construction so each render pass is an O(|selection|) Map lookup rather
    // than an O(|catalog|) scan. Hooks are already filtered by the constructor
    // above, so this map reflects only tabbed items.
    const tokensById = new Map<string, number>();
    for (const tab of tabs) {
      for (const item of tab.items) {
        tokensById.set(canonicalItemId(item.item), item.tokenEstimate?.tokens ?? 0);
      }
    }
    this.tokensById = tokensById;
    this.selectedIds = new Set<string>();
    this.useAscii = useAscii;
    this.now = now;
    this.stdoutRows = input.stdoutRows;
    this.terminalCols = input.terminalCols ?? 80;
    if (input.renderTokenCounter !== undefined) {
      // Test/legacy caller seam (D3.1-12). Overrides the live Phase 4 renderer.
      this.renderTokenCounter = input.renderTokenCounter;
    } else {
      // Phase 4 D4-03 / D4-10: live footer implementation replaces the Phase 3.1
      // no-op stub. Signature unchanged so the _renderFrame() layout contract
      // (D3.1-12) holds.
      this.renderTokenCounter = () => {
        const total = this._computeSelectionTotal();
        return formatTokensApprox(total, { ascii: this.useAscii });
      };
    }
    this.viewportHeightOverride = input.viewportHeightOverride;

    // Key dispatch: char-based keys + modifier-based tab switching.
    // info.name is a node:readline Key.name (e.g. 'tab', 'pageup', 'home').
    // The base class auto-calls render() after every keypress, so mutating
    // instance state here is sufficient — no explicit render call needed.
    this.on('key', (char, info) => {
      // Phase 5 D5-13: help overlay gate. `?` toggles the overlay from ANY
      // state (including filter mode — per CONTEXT "Claude's Discretion":
      // `?` is always routed to help). While open, swallow every key except
      // `?` (toggle off) and `Esc` (close). Ctrl+C remains live via the
      // base class's cancel handler (INV-S2, T-05-02 mitigation).
      if (this.helpOpen) {
        if (char === '?' || info?.name === 'escape') {
          this.helpOpen = false;
          this.state = 'active';
        }
        // Every other key is swallowed while help is open.
        return;
      }
      if (char === '?') {
        this.helpOpen = true;
        this.state = 'active';
        return;
      }
      // Phase 5 filter-input mode (D5-04, D5-05). Priority over all other
      // non-cancel bindings: typed chars/backspace mutate the query, Esc
      // clears+exits in one stroke, Enter exits but keeps query.
      // Ctrl+C is still honored because @clack/core's base cancel handler
      // processes it before or independently of this listener — we never
      // swallow it here (INV-S2).
      if (this.filterMode) {
        const st = this.filterSortByTab[this.activeTabIndex];
        if (!st) return;
        if (info?.name === 'escape') {
          st.query = '';
          st.active = false;
          this.filterMode = false;
          this._clampActiveCursor();
          this.state = 'active';
          return;
        }
        if (info?.name === 'return') {
          this.filterMode = false;
          if (st.query === '') st.active = false;
          this.state = 'active';
          return;
        }
        if (info?.name === 'backspace') {
          st.query = st.query.slice(0, -1);
          if (st.query === '') st.active = false;
          else st.active = true;
          this._clampActiveCursor();
          this.state = 'active';
          return;
        }
        // Tab / Shift-Tab exit filter mode and delegate to tab-switch logic
        // (the tab-switch itself clears the departing tab's filter per D5-03).
        if (info?.name === 'tab') {
          this.filterMode = false;
          if (info.shift === true) this.prevTab();
          else this.nextTab();
          this.state = 'active';
          return;
        }
        // Printable character append (codepoint ≥ 32, not DEL, single-char
        // only). `/`, `s`, alphanumerics, punctuation all route here (D5-04).
        if (typeof char === 'string' && char.length === 1) {
          const code = char.charCodeAt(0);
          if (code >= 32 && code !== 127) {
            st.query = sanitizeFilterQuery(st.query + char);
            st.active = true;
            // Reset cursor to 0 on query change — the visible slice is new.
            this.tabs[this.activeTabIndex]!.cursor = 0;
            this.state = 'active';
            return;
          }
        }
        // In filter mode all other keys are swallowed. Cancel (Ctrl+C) is
        // handled by the base class independent of this listener.
        return;
      }

      // Phase 4 integration test seam (gated on env — production path is dead code).
      // The pty-based SIGWINCH test cannot fire a real 'resize' event because the
      // child process stdout is a pipe, not a TTY. CCAUDIT_TEST_RESIZE=1 lets the
      // test send Ctrl+R to invoke _handleResize() directly. Optional env var
      // CCAUDIT_TEST_RESIZE_ROWS drives the post-resize stdoutRows.
      if (process.env.CCAUDIT_TEST_RESIZE === '1' && char === '\x12') {
        // Invoke the resize handler, THEN overwrite stdoutRows with the forced
        // value (handleResize reads process.stdout.rows which is undefined on
        // piped stdio, so it would otherwise clobber the test-supplied value).
        this._handleResize();
        const forcedRows = process.env.CCAUDIT_TEST_RESIZE_ROWS;
        if (forcedRows !== undefined && /^\d+$/.test(forcedRows)) {
          this.stdoutRows = parseInt(forcedRows, 10);
        }
        // Nudge @clack/core to re-render after the forced rows take effect.
        this.state = 'active';
        return;
      }
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
      // Phase 5 D5-01: '/' enters filter input mode for the active tab.
      if (char === '/') {
        const st = this.filterSortByTab[this.activeTabIndex];
        if (st) {
          this.filterMode = true;
          st.active = true;
        }
        this.state = 'active';
        return;
      }
      // Phase 5 D5-08: 's' cycles the active tab's sort mode.
      if (char === 's') {
        const st = this.filterSortByTab[this.activeTabIndex];
        if (st) {
          st.sort = nextSort(st.sort);
          this._clampActiveCursor();
        }
        this.state = 'active';
        return;
      }
    });

    // Cursor dispatch: arrow keys + space + enter + cancel (via base aliases).
    // 'left'/'right' also cycle tabs (D3.1-01), matching Tab/Shift-Tab.
    this.on('cursor', (action) => {
      // Phase 5 D5-13 / T-05-02: while help overlay is open, swallow all
      // cursor actions EXCEPT `cancel` — Ctrl+C must still cancel the
      // picker (INV-S2). Arrow keys, space, enter are no-ops while help
      // is showing; closing the overlay returns control unchanged.
      if (this.helpOpen && action !== 'cancel') return;
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

  /**
   * Phase 5 D5-11: compute visible items for tab — sort first, then filter.
   * Sort is always applied (default `staleness-desc` is identical to pre-sort
   * scan output for backward compat). Filter narrows only when `state.active`
   * AND query is non-empty.
   */
  public visibleItemsForTab(tabIdx: number): TokenCostResult[] {
    const state = this.filterSortByTab[tabIdx];
    const tab = this.tabs[tabIdx];
    if (!state || !tab) return [];
    const sorted = sortItems(tab.items, state.sort, this.now);
    if (state.active && state.query !== '') {
      return sorted.filter((x) => matchesQuery(x.item.name, state.query));
    }
    return sorted;
  }

  private _visibleActive(): TokenCostResult[] {
    return this.visibleItemsForTab(this.activeTabIndex);
  }

  /**
   * Phase 5 D5-03: on tab switch, clear the DEPARTING tab's filter (query +
   * active flag). Sort mode on the departing tab is preserved per D5-09.
   * Global `filterMode` is always exited on tab switch. Active tab's cursor
   * is clamped to the new visible-slice bounds.
   */
  private _onTabSwitch(): void {
    const departing = this.filterSortByTab[this.activeTabIndex];
    if (departing) {
      departing.active = false;
      departing.query = '';
    }
    this.filterMode = false;
  }

  private _clampActiveCursor(): void {
    const t = this.tabs[this.activeTabIndex];
    if (!t) return;
    const vlen = this._visibleActive().length;
    t.cursor = Math.min(t.cursor, Math.max(0, vlen - 1));
  }

  public nextTab(): void {
    this._onTabSwitch();
    this.activeTabIndex = (this.activeTabIndex + 1) % this.tabs.length;
    this._clampActiveCursor();
  }

  public prevTab(): void {
    this._onTabSwitch();
    this.activeTabIndex = (this.activeTabIndex - 1 + this.tabs.length) % this.tabs.length;
    this._clampActiveCursor();
  }

  public jumpToTab(index: number): void {
    if (index < 0 || index >= this.tabs.length) return; // no-op (D3.1-02)
    this._onTabSwitch();
    this.activeTabIndex = index;
    this._clampActiveCursor();
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
    const vlen = this._visibleActive().length;
    t.cursor = Math.min(Math.max(0, vlen - 1), t.cursor + 1);
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
    const vlen = this._visibleActive().length;
    t.cursor = Math.min(Math.max(0, vlen - 1), t.cursor + vh);
  }

  public cursorHome(): void {
    this.activeTab().cursor = 0;
  }

  public cursorEnd(): void {
    const t = this.activeTab();
    const vlen = this._visibleActive().length;
    t.cursor = Math.max(0, vlen - 1);
  }

  // ---------------------------------------------------------------------------
  // Selection operations
  // ---------------------------------------------------------------------------

  public toggleCurrentRow(): void {
    if (this._terminalTooSmall()) return; // D4-08: suppress row interactivity.
    const t = this.activeTab();
    const visible = this._visibleActive();
    const item = visible[t.cursor];
    if (!item) return;
    const id = canonicalItemId(item.item);
    if (this.selectedIds.has(id)) this.selectedIds.delete(id);
    else this.selectedIds.add(id);
  }

  /**
   * D3.1-15: `a` scope is active tab only in v0.5. If every item in the active
   * tab is already selected, deselect them all; otherwise select them all.
   *
   * Phase 5: when a filter is active on this tab, operate ONLY on currently
   * VISIBLE items (GitHub/Gmail-style select-all-or-clear on the filtered
   * group, per D5-17). Hidden selections are preserved.
   */
  public toggleAllInActiveTab(): void {
    if (this._terminalTooSmall()) return; // D4-08.
    const t = this.activeTab();
    const state = this.filterSortByTab[this.activeTabIndex];
    const filterActive = state?.active === true && state.query !== '';
    const source = filterActive ? this._visibleActive() : t.items;
    const ids = source.map((i) => canonicalItemId(i.item));
    const allSelected = ids.length > 0 && ids.every((id) => this.selectedIds.has(id));
    if (allSelected) {
      for (const id of ids) this.selectedIds.delete(id);
    } else {
      for (const id of ids) this.selectedIds.add(id);
    }
  }

  /**
   * Phase 4 D4-12: sum the tokens of the currently selected canonical ids.
   * O(|selectedIds|) — catalog map is built once at construction.
   */
  private _computeSelectionTotal(): number {
    let total = 0;
    for (const id of this.selectedIds) {
      total += this.tokensById.get(id) ?? 0;
    }
    return total;
  }

  /**
   * Phase 4 D4-04: tokens for the currently-active tab only.
   * Used in the per-tab header to render `(N/M · ≈ Xk)`.
   */
  private _computeActiveTabTokens(): number {
    const t = this.tabs[this.activeTabIndex]!;
    let total = 0;
    for (const item of t.items) {
      const id = canonicalItemId(item.item);
      if (this.selectedIds.has(id)) {
        total += this.tokensById.get(id) ?? 0;
      }
    }
    return total;
  }

  /**
   * Phase 4 D4-08: sub-minimum terminal cliff. Below 14 rows or 60 cols we
   * render a banner and suppress row interactivity. Cancel keys stay live.
   */
  private _terminalTooSmall(): boolean {
    const rows = this.stdoutRows ?? 24;
    const cols = this.terminalCols;
    return rows < 14 || cols < 60;
  }

  /**
   * Phase 4 D4-06 / D4-09: register a throttled SIGWINCH handler on process.stdout.
   * Safe to call multiple times — subsequent calls are no-ops while one is live.
   * Always paired with _unregisterResize() on prompt exit.
   */
  public _registerResize(): void {
    if (this._resizeHandler !== null) return;
    const handler = (): void => {
      // D4-09: coalesce bursts at 50ms. Trailing-edge render only — every
      // incoming resize event pushes the timer forward, and the render fires
      // once when the 50ms window finally elapses without a new event.
      if (this._resizeThrottleTimer !== null) {
        clearTimeout(this._resizeThrottleTimer);
      }
      this._resizeThrottleTimer = setTimeout(() => {
        this._resizeThrottleTimer = null;
        this._handleResize();
      }, 50);
    };
    this._resizeHandler = handler;
    process.stdout.on('resize', handler);
  }

  public _unregisterResize(): void {
    if (this._resizeHandler !== null) {
      process.stdout.off('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._resizeThrottleTimer !== null) {
      clearTimeout(this._resizeThrottleTimer);
      this._resizeThrottleTimer = null;
    }
  }

  /**
   * Phase 4 D4-07: read the current stdout dimensions into the picker's cached
   * values and force a re-render. State preservation is automatic because
   * activeTabIndex, per-tab cursor, and selectedIds live on `this` — only the
   * geometry changes. D4-08 sub-minimum branch is handled inside _renderFrame.
   */
  public _handleResize(): void {
    this.stdoutRows = process.stdout.rows;
    this.terminalCols = process.stdout.columns ?? 80;
    // Nudge the base class to redraw. @clack/core re-renders on state writes.
    this.state = 'active';
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

  /**
   * Phase 4 D4-06: register SIGWINCH on entry, unregister on exit (submit,
   * cancel, or exception). Delegates the actual interactive loop to the base
   * class's prompt() method. Returns the same Promise shape so
   * openTabbedPicker's isCancel(result) check keeps working.
   */
  public override async prompt(): Promise<string[] | symbol | undefined> {
    this._registerResize();
    try {
      return await super.prompt();
    } finally {
      this._unregisterResize();
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  public _renderFrame(): string {
    // WR-01 guard: @clack/core.MultiSelectPrompt installs its own `on('key', …)`
    // and `on('cursor', …)` handlers in its constructor that mutate `this.value`
    // via `toggleAll` / `toggleValue` using the flat-options list with `cursor`
    // synced to the active tab's LOCAL cursor. Our subclass's handlers run
    // AFTER the base, so `this.value` silently diverges from `this.selectedIds`
    // between keypresses. The submit() path already overwrites `this.value`
    // before state transitions, but any consumer that reads `this.value`
    // mid-prompt (or any future @clack/core key binding we don't know about)
    // would see incoherent state. Syncing at every render keeps `this.value`
    // authoritative across the full lifetime of the prompt — it runs on every
    // keypress and is cheap (Set → Array copy).
    this.value = Array.from(this.selectedIds);

    // Phase 5 D5-13: help overlay render branch. When open, replace the
    // picker frame entirely with `renderHelpOverlay(...)`. Selection,
    // cursor, active tab, and filter/sort state are all untouched — they
    // resume exactly on close (`?` or `Esc`).
    if (this.helpOpen) {
      return renderHelpOverlay({
        useAscii: this.useAscii,
        rows: this.stdoutRows ?? 24,
        cols: this.terminalCols,
      });
    }

    // Phase 4 D4-08: sub-minimum terminal branch. We still draw a minimal frame
    // so the user sees why interactivity is suppressed AND learns the escape
    // hatch. Cancel keys (q / Ctrl+C / Esc) remain live — they are handled in
    // the base class key dispatcher and are NOT gated by _terminalTooSmall().
    if (this._terminalTooSmall()) {
      const warnGlyph = this.useAscii ? '!' : '⚠';
      return `${warnGlyph} Terminal too small (need ≥14r × 60c). Resize to continue or press q.`;
    }

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
    // N/M count reflects the underlying tab items (not the visible slice),
    // consistent with Phase 3.1/4 semantics.
    const selectedInTab = t.items.filter((i) =>
      this.selectedIds.has(canonicalItemId(i.item)),
    ).length;
    const totalInTab = t.items.length;
    // Phase 4 D4-04: per-tab header extends to `(N/M · ≈ Xk)` when N > 0.
    // When N === 0 we suppress the `· ≈ 0k` suffix to keep the header calm.
    let header: string;
    if (selectedInTab > 0) {
      const activeTabTokens = this._computeActiveTabTokens();
      const activeApprox = formatTokensApprox(activeTabTokens, { ascii: this.useAscii });
      // activeApprox is e.g. '≈ 2k tokens' or '~ 2k tokens' or '350 tokens'.
      // For the per-tab header we want just the leading approx value without
      // the trailing ' tokens' word — strip it to keep the header compact.
      const compact = activeApprox.replace(/\s*tokens$/, '');
      if (compact === '') {
        header = `${t.label} (${selectedInTab}/${totalInTab})`;
      } else {
        header = `${t.label} (${selectedInTab}/${totalInTab} · ${compact})`;
      }
    } else {
      header = `${t.label} (${selectedInTab}/${totalInTab})`;
    }
    // Phase 5 D5-12: append sort label ONLY when sort mode != default.
    const activeState = this.filterSortByTab[this.activeTabIndex];
    if (activeState && activeState.sort !== 'staleness-desc') {
      const suffix = activeState.sort === 'tokens-desc' ? 'tokens' : 'name';
      header = `${header} · sort:${suffix}`;
    }
    lines.push(pc.bold(header));

    // 3–5. Viewport window + ↑/↓ N more indicators (D3.1-06).
    // Phase 5: render the VISIBLE slice (sorted-then-filtered) — cursor is
    // an index into this slice.
    const visible = this._visibleActive();
    const vh = computeViewportHeight({
      rowsOverride: this.viewportHeightOverride,
      stdoutRows: this.stdoutRows,
    });
    // Clamp cursor into bounds for a safe windowRows call even if prior key
    // handling left a stale cursor.
    if (visible.length === 0) {
      t.cursor = 0;
    } else if (t.cursor >= visible.length) {
      t.cursor = visible.length - 1;
    }
    const win = windowRows({ rows: visible, cursor: t.cursor, viewportHeight: vh });

    // Phase 5 D5-07: empty-result placeholder when filter excludes all rows.
    if (visible.length === 0 && activeState?.active === true && activeState.query !== '') {
      lines.push(pc.dim('No matches. Press Esc to clear.'));
    } else {
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
    }

    // 6. Hint / filter-input line.
    if (this.filterMode) {
      // Phase 5 D5-01: footer hint becomes the filter input. The trailing
      // underscore is an ASCII cursor glyph (D5-21). Defense-in-depth sanitize
      // at render time too (T-05-01) so any future code path that bypasses
      // the append-time sanitizer still can't inject terminal escapes here.
      const echoQuery = sanitizeFilterQuery(activeState?.query ?? '');
      lines.push(`Filter: ${echoQuery}_`);
    } else {
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
    }

    // 7. Global count + live token counter on a SINGLE line (D4-03) — OR
    // Phase 5 D5-01 filtered-count line when the filter is active on the
    // current tab OR the user is typing into the filter input.
    const totalItems = this.tabs.reduce((sum, tab) => sum + tab.items.length, 0);
    const filterActiveHere = this.filterMode || activeState?.active === true;

    if (filterActiveHere) {
      // Phase 5 D5-01 + D5-20: `Filtered: M of N visible · X selected [(incl. hidden)]?`
      // where M = visible count on active tab, N = total items on active tab,
      // X = ALL selections across all tabs (including hidden). Append
      // `(incl. hidden)` ONLY when at least one selected id is NOT in the
      // currently-visible slice of ANY tab.
      const M = visible.length;
      const N = t.items.length;
      const X = this.selectedIds.size;

      // Compute the set of visible canonical ids across all tabs to determine
      // whether any selections are hidden. This is O(sum of visible lengths)
      // per render, which is bounded by total catalog size — same cost class
      // as the existing per-tab selection scan.
      const visibleIds = new Set<string>();
      for (let i = 0; i < this.tabs.length; i++) {
        const vi = this.visibleItemsForTab(i);
        for (const item of vi) visibleIds.add(canonicalItemId(item.item));
      }
      let hiddenSelected = 0;
      for (const id of this.selectedIds) {
        if (!visibleIds.has(id)) hiddenSelected++;
      }
      const dotFilter = this.useAscii ? '|' : '·';
      const hiddenSuffix = hiddenSelected > 0 ? ' (incl. hidden)' : '';
      lines.push(`Filtered: ${M} of ${N} visible ${dotFilter} ${X} selected${hiddenSuffix}`);
    } else {
      const counterSuffix = this.renderTokenCounter();
      // counterSuffix is '' or '≈ Zk tokens' or '350 tokens' (or '~ Zk tokens' in ASCII mode).
      // Rewrite it to `≈ Zk tokens saved` / '350 tokens saved' / ''.
      const counterDisplay = counterSuffix === '' ? '' : `${counterSuffix} saved`;
      const dotGlobal = this.useAscii ? '|' : '·';
      const globalLine =
        counterDisplay === ''
          ? `${this.selectedIds.size} of ${totalItems} selected across all tabs`
          : `${this.selectedIds.size} of ${totalItems} selected across all tabs ${dotGlobal} ${counterDisplay}`;
      lines.push(globalLine);
    }

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
        makeGhost({ name: 'c1', category: 'command', tokens: 50 }),
      ];
      const picker = makePicker(ghosts);
      expect(picker.tabs.length).toBe(3);
      // CATEGORY_ORDER is agent, skill, mcp-server, memory, command, hook — so
      // the three non-empty categories render in that order (hook would be
      // filtered out by the Phase 3.2 SC6 skip even if present).
      expect(picker.tabs[0]!.label).toBe('AGENTS');
      expect(picker.tabs[1]!.label).toBe('SKILLS');
      expect(picker.tabs[2]!.label).toBe('COMMANDS');
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

    it('Phase 3.2 SC6: hook-category items are filtered out of tabs entirely', () => {
      // Input has 4 categories including hooks; tab list should exclude HOOKS.
      const ghosts = [
        makeGhost({ name: 'a1', category: 'agent', tokens: 100 }),
        makeGhost({ name: 'mcp1', category: 'mcp-server', tokens: 500 }),
        makeGhost({ name: 'cmd1', category: 'command', tokens: 30 }),
        makeGhost({ name: 'hook1', category: 'hook', tokens: 2000 }),
        makeGhost({ name: 'hook2', category: 'hook', tokens: 2500 }),
      ];
      const picker = makePicker(ghosts);
      expect(picker.tabs.length).toBe(3);
      const ids = picker.tabs.map((t) => t.categoryId);
      expect(ids).not.toContain('hook');
      expect(ids).toEqual(['agent', 'mcp-server', 'command']);
    });

    it('Phase 3.2 SC6: WR-02 exhaustiveness guard still fires for unknown categories', () => {
      // A category that is NOT in CATEGORY_ORDER must still throw. This protects
      // against a future typo where someone adds 'bookmark' (etc.) to the scanner
      // without wiring the tab. The hook-skip does NOT loosen this guard — the
      // skip is AFTER the knownCategories check.
      const rogueGhost = makeGhost({
        name: 'x1',
        category: 'not-a-category',
        tokens: 100,
      });
      expect(() => makePicker([rogueGhost])).toThrow(/unknown category/);
    });

    it('Phase 3.2 SC6: input of ONLY hook items throws the empty-tabs guard', () => {
      const ghosts = [
        makeGhost({ name: 'hook1', category: 'hook', tokens: 100 }),
        makeGhost({ name: 'hook2', category: 'hook', tokens: 200 }),
      ];
      expect(() => makePicker(ghosts)).toThrow(/no non-empty categories/);
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
        makeGhost({ name: 'c1', category: 'command', tokens: 50 }),
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
        makeGhost({ name: 'c1', category: 'command', tokens: 50 }),
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
        makeGhost({ name: 'c1', category: 'command', tokens: 50 }),
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

    it('WR-01: picker.value stays coherent with selectedIds after render + submit', () => {
      // Regression guard for the base-class double-dispatch footgun:
      //   @clack/core.MultiSelectPrompt's key bindings mutate `this.value`
      //   independently of our `this.selectedIds` set. `_renderFrame()` now
      //   resynchronises `this.value` from `selectedIds` at every render so
      //   the two never silently diverge. `submit()` still overwrites
      //   `this.value` as a final safety net.
      const ghosts = [
        makeGhost({ name: 'a1', category: 'agent', tokens: 100 }),
        makeGhost({ name: 'a2', category: 'agent', tokens: 80 }),
        makeGhost({ name: 's1', category: 'skill', tokens: 200 }),
      ];
      const picker = makePicker(ghosts);

      // Simulate toggling two items across two tabs via our subclass's
      // own mutators (the fake "happy path" that does not trigger base
      // bindings — but the render-time sync must still mirror the state).
      picker.toggleCurrentRow(); // a1 (tab 0 cursor 0)
      picker.cursorDown();
      picker.toggleCurrentRow(); // a2 (tab 0 cursor 1)
      picker.nextTab(); // tab 1
      picker.toggleCurrentRow(); // s1

      // Render once — this is the step that synchronises `this.value`.
      picker._renderFrame();

      const valueSorted = [...picker.value!].sort();
      const selectedSorted = Array.from(picker.selectedIds).sort();
      expect(valueSorted).toEqual(selectedSorted);
      expect(valueSorted.length).toBe(3);

      // Submit() also forces the sync as the final safety net.
      picker.submit();
      const submitValueSorted = [...picker.value!].sort();
      expect(submitValueSorted).toEqual(selectedSorted);
    });

    it('WR-02: constructor throws on ghost whose category is not in CATEGORY_ORDER', () => {
      // Exhaustiveness guard against a future domain-type expansion landing
      // without updating CATEGORY_ORDER — silently dropping the category
      // would be a data-loss regression. makeGhost's `category` param is
      // typed `string` and then cast to the union internally, so we can
      // exercise a runtime value the static union rules out.
      const rogueGhost = makeGhost({
        name: 'rogue',
        category: 'nonexistent-category',
        tokens: 100,
      });
      expect(() => makePicker([rogueGhost])).toThrow(/unknown category 'nonexistent-category'/);
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

    describe('Phase 4 live token counter', () => {
      it('footer drops token suffix when selection is empty', () => {
        const ghosts = [
          makeGhost({ name: 'a1', category: 'agent', tokens: 1500 }),
          makeGhost({ name: 's1', category: 'skill', tokens: 2000 }),
        ];
        const picker = makePicker(ghosts);
        const frame = picker._renderFrame();
        expect(frame).toContain('0 of 2 selected across all tabs');
        expect(frame).not.toContain('tokens saved');
        // Per-tab header with N=0 MUST NOT include the subtotal segment.
        expect(frame).toContain('AGENTS (0/1)');
        expect(frame).not.toContain('AGENTS (0/1 ·');
        expect(frame).not.toContain('AGENTS (0/1 |');
      });

      it('footer shows ≈ Zk tokens saved after toggling one 1500-token item (ASCII mode: ~ 2k)', () => {
        const ghosts = [
          makeGhost({ name: 'a1', category: 'agent', tokens: 1500 }),
          makeGhost({ name: 's1', category: 'skill', tokens: 2000 }),
        ];
        const picker = makePicker(ghosts); // useAscii=true from makePicker default
        picker.toggleCurrentRow();
        const frame = picker._renderFrame();
        expect(frame).toContain('1 of 2 selected across all tabs | ~ 2k tokens saved');
        expect(frame).toContain('AGENTS (1/1 · ~ 2k)');
      });

      it('toggleAllInActiveTab updates both the tab header subtotal and the global footer', () => {
        const ghosts = [
          makeGhost({ name: 'a1', category: 'agent', tokens: 1000 }),
          makeGhost({ name: 'a2', category: 'agent', tokens: 500 }),
          makeGhost({ name: 'a3', category: 'agent', tokens: 250 }),
          makeGhost({ name: 's1', category: 'skill', tokens: 4000 }),
        ];
        const picker = makePicker(ghosts);
        picker.toggleAllInActiveTab();
        const frame = picker._renderFrame();
        expect(frame).toContain('AGENTS (3/3 · ~ 2k)');
        expect(frame).toContain('3 of 4 selected across all tabs | ~ 2k tokens saved');
      });

      it('cross-tab selection sums into the global footer but only the active tab shows its own subtotal in the header', () => {
        const ghosts = [
          makeGhost({ name: 'a1', category: 'agent', tokens: 3000 }),
          makeGhost({ name: 's1', category: 'skill', tokens: 2000 }),
        ];
        const picker = makePicker(ghosts);
        picker.toggleCurrentRow();
        picker.nextTab();
        picker.toggleCurrentRow();
        const frame = picker._renderFrame();
        expect(frame).toContain('SKILLS (1/1 · ~ 2k)');
        expect(frame).toContain('2 of 2 selected across all tabs | ~ 5k tokens saved');
        expect(frame).not.toContain('AGENTS (1/1 · ~ 3k)');
      });

      it('items with null tokenEstimate contribute 0 to both subtotal and footer', () => {
        const ghosts = [
          makeGhost({ name: 'a1', category: 'agent' }),
          makeGhost({ name: 'a2', category: 'agent', tokens: 1500 }),
        ];
        const picker = makePicker(ghosts);
        // Tab items sort descending by tokens, so a2 (1500) is at cursor 0 and
        // a1 (null → 0) is at cursor 1. Navigate to a1 then toggle.
        picker.cursorDown();
        picker.toggleCurrentRow();
        const frame = picker._renderFrame();
        // With a single 0-token selection the subtotal is 0 → header shows
        // bare N/M (0 formats to empty); footer shows count line without
        // "tokens saved".
        expect(frame).toContain('AGENTS (1/2)');
        expect(frame).toContain('1 of 2 selected across all tabs');
        expect(frame).not.toContain('tokens saved');
      });
    });

    describe('Phase 4 resize + sub-minimum terminal', () => {
      it('sub-minimum terminal (stdoutRows=10) returns the banner as the entire frame', () => {
        const ghosts = [
          makeGhost({ name: 'a1', category: 'agent', tokens: 100 }),
          makeGhost({ name: 's1', category: 'skill', tokens: 200 }),
        ];
        const picker = new TabbedGhostPicker({
          ghosts,
          useAscii: true,
          stdoutRows: 10,
          terminalCols: 120,
        });
        const frame = picker._renderFrame();
        expect(frame).toContain('! Terminal too small');
        expect(frame).toContain('press q');
        expect(frame).not.toContain('AGENTS (');
        expect(frame).not.toContain('selected across all tabs');
      });

      it('sub-minimum terminal (terminalCols=40) returns the banner', () => {
        const ghosts = [makeGhost({ name: 'a1', category: 'agent', tokens: 100 })];
        const picker = new TabbedGhostPicker({
          ghosts,
          useAscii: true,
          stdoutRows: 24,
          terminalCols: 40,
        });
        expect(picker._renderFrame()).toContain('Terminal too small');
      });

      it('sub-minimum terminal suppresses Space/a interactivity (selection set unchanged)', () => {
        const ghosts = [
          makeGhost({ name: 'a1', category: 'agent', tokens: 100 }),
          makeGhost({ name: 'a2', category: 'agent', tokens: 200 }),
        ];
        const picker = new TabbedGhostPicker({
          ghosts,
          useAscii: true,
          stdoutRows: 10,
          terminalCols: 120,
        });
        expect(picker.selectedIds.size).toBe(0);
        picker.toggleCurrentRow();
        expect(picker.selectedIds.size).toBe(0);
        picker.toggleAllInActiveTab();
        expect(picker.selectedIds.size).toBe(0);
      });

      it('Unicode banner glyph when useAscii=false', () => {
        const ghosts = [makeGhost({ name: 'a1', category: 'agent', tokens: 100 })];
        const picker = new TabbedGhostPicker({
          ghosts,
          useAscii: false,
          stdoutRows: 10,
          terminalCols: 120,
        });
        expect(picker._renderFrame()).toContain('⚠ Terminal too small');
      });

      it('caller-provided renderTokenCounter override is honored (D3.1-12 seam preserved)', () => {
        const ghosts = [makeGhost({ name: 'a1', category: 'agent', tokens: 100 })];
        const picker = new TabbedGhostPicker({
          ghosts,
          useAscii: true,
          stdoutRows: 24,
          terminalCols: 120,
          renderTokenCounter: () => 'CUSTOM_FOOTER',
        });
        const frame = picker._renderFrame();
        expect(frame).toContain('CUSTOM_FOOTER');
      });

      it('_registerResize/_unregisterResize add then remove exactly one stdout resize listener', () => {
        const ghosts = [makeGhost({ name: 'a1', category: 'agent', tokens: 100 })];
        const picker = new TabbedGhostPicker({
          ghosts,
          useAscii: true,
          stdoutRows: 24,
          terminalCols: 120,
        });
        const before = process.stdout.listenerCount('resize');
        picker._registerResize();
        expect(process.stdout.listenerCount('resize')).toBe(before + 1);
        picker._unregisterResize();
        expect(process.stdout.listenerCount('resize')).toBe(before);
      });
    });

    // ---------------------------------------------------------------------
    // Phase 5: filter + sort integration
    // ---------------------------------------------------------------------

    /**
     * Fire a 'key' event at the picker's registered listener. `info.name` is
     * the node:readline key name (e.g. 'escape', 'return', 'backspace',
     * 'tab'). `char` is the typed character or undefined for named keys.
     */
    function fireKey(
      picker: TabbedGhostPicker,
      char: string | undefined,
      info?: { name?: string; shift?: boolean },
    ): void {
      (picker as unknown as { emit: (event: string, ...args: unknown[]) => boolean }).emit(
        'key',
        char,
        info,
      );
    }

    describe('Phase 5 filter + sort — Task 1 state + visibility', () => {
      it('defaultFilterSortState is set per tab on construction', () => {
        const ghosts = [
          makeGhost({ name: 'a1', category: 'agent' }),
          makeGhost({ name: 's1', category: 'skill' }),
        ];
        const picker = makePicker(ghosts);
        expect(picker.filterSortByTab.length).toBe(2);
        for (const st of picker.filterSortByTab) {
          expect(st).toEqual({ query: '', active: false, sort: 'staleness-desc' });
        }
        expect(picker.filterMode).toBe(false);
      });

      it('visibleItemsForTab narrows by name substring (D5-01/D5-02)', () => {
        const ghosts = [
          makeGhost({ name: 'alpha', category: 'agent', tokens: 100 }),
          makeGhost({ name: 'beta', category: 'agent', tokens: 200 }),
          makeGhost({ name: 'gamma-alpha', category: 'agent', tokens: 50 }),
        ];
        const picker = makePicker(ghosts);
        picker.filterSortByTab[0]!.active = true;
        picker.filterSortByTab[0]!.query = 'ALPHA';
        const names = picker.visibleItemsForTab(0).map((x) => x.item.name);
        expect(names).toEqual(expect.arrayContaining(['alpha', 'gamma-alpha']));
        expect(names).not.toContain('beta');
      });

      it('filter does NOT drop selected ids for hidden rows (D5-06)', () => {
        const ghosts = [
          makeGhost({ name: 'alpha', category: 'agent', tokens: 100 }),
          makeGhost({ name: 'beta', category: 'agent', tokens: 200 }),
        ];
        const picker = makePicker(ghosts);
        // Select both.
        picker.toggleAllInActiveTab();
        expect(picker.selectedIds.size).toBe(2);
        // Filter to only 'alpha' — 'beta' is hidden.
        picker.filterSortByTab[0]!.active = true;
        picker.filterSortByTab[0]!.query = 'alpha';
        expect(picker._renderFrame()).toBeTruthy();
        // Selections preserved.
        expect(picker.selectedIds.size).toBe(2);
      });

      it('visibleItemsForTab sorts first then filters (D5-11)', () => {
        const ghosts = [
          makeGhost({ name: 'aa', category: 'agent', tokens: 10 }),
          makeGhost({ name: 'ab', category: 'agent', tokens: 30 }),
          makeGhost({ name: 'ac', category: 'agent', tokens: 20 }),
        ];
        const picker = makePicker(ghosts);
        picker.filterSortByTab[0]!.sort = 'tokens-desc';
        picker.filterSortByTab[0]!.active = true;
        picker.filterSortByTab[0]!.query = 'a';
        const names = picker.visibleItemsForTab(0).map((x) => x.item.name);
        // Tokens desc: ab(30), ac(20), aa(10). Filter 'a' matches all.
        expect(names).toEqual(['ab', 'ac', 'aa']);
      });

      it('per-tab sort persists across tab switch (D5-09)', () => {
        const ghosts = [
          makeGhost({ name: 'a1', category: 'agent' }),
          makeGhost({ name: 's1', category: 'skill' }),
        ];
        const picker = makePicker(ghosts);
        picker.filterSortByTab[0]!.sort = 'tokens-desc';
        picker.nextTab();
        picker.prevTab();
        expect(picker.filterSortByTab[0]!.sort).toBe('tokens-desc');
      });

      it('tab switch resets the departing tab filter query + active flag (D5-03); sort mode preserved', () => {
        const ghosts = [
          makeGhost({ name: 'alpha', category: 'agent' }),
          makeGhost({ name: 's1', category: 'skill' }),
        ];
        const picker = makePicker(ghosts);
        picker.filterSortByTab[0]!.active = true;
        picker.filterSortByTab[0]!.query = 'alpha';
        picker.filterSortByTab[0]!.sort = 'tokens-desc';
        picker.filterMode = true;
        picker.nextTab();
        expect(picker.filterMode).toBe(false);
        expect(picker.filterSortByTab[0]!.query).toBe('');
        expect(picker.filterSortByTab[0]!.active).toBe(false);
        // Sort preserved.
        expect(picker.filterSortByTab[0]!.sort).toBe('tokens-desc');
      });

      it('toggleAllInActiveTab with active filter toggles only VISIBLE items (D5-17)', () => {
        const ghosts = [
          makeGhost({ name: 'alpha', category: 'agent' }),
          makeGhost({ name: 'beta', category: 'agent' }),
          makeGhost({ name: 'alphasecond', category: 'agent' }),
        ];
        const picker = makePicker(ghosts);
        picker.filterSortByTab[0]!.active = true;
        picker.filterSortByTab[0]!.query = 'alpha';
        picker.toggleAllInActiveTab();
        // Only 'alpha' + 'alphasecond' are visible → both selected. 'beta' not selected.
        expect(picker.selectedIds.has('agent|global||/fake/alpha')).toBe(true);
        expect(picker.selectedIds.has('agent|global||/fake/alphasecond')).toBe(true);
        expect(picker.selectedIds.has('agent|global||/fake/beta')).toBe(false);
      });
    });

    describe('Phase 5 filter + sort — Task 2 key bindings + footer', () => {
      it("'/' then typed chars: filterMode = true, query grows, visible slice narrows", () => {
        const ghosts = [
          makeGhost({ name: 'alpha', category: 'agent' }),
          makeGhost({ name: 'beta', category: 'agent' }),
        ];
        const picker = makePicker(ghosts);
        fireKey(picker, '/');
        expect(picker.filterMode).toBe(true);
        fireKey(picker, 'a');
        fireKey(picker, 'l');
        expect(picker.filterSortByTab[0]!.query).toBe('al');
        const names = picker.visibleItemsForTab(0).map((x) => x.item.name);
        expect(names).toEqual(['alpha']);
      });

      it('Backspace in filter mode shrinks query', () => {
        const ghosts = [makeGhost({ name: 'alpha', category: 'agent' })];
        const picker = makePicker(ghosts);
        fireKey(picker, '/');
        fireKey(picker, 'a');
        fireKey(picker, 'b');
        expect(picker.filterSortByTab[0]!.query).toBe('ab');
        fireKey(picker, undefined, { name: 'backspace' });
        expect(picker.filterSortByTab[0]!.query).toBe('a');
        fireKey(picker, undefined, { name: 'backspace' });
        expect(picker.filterSortByTab[0]!.query).toBe('');
        expect(picker.filterSortByTab[0]!.active).toBe(false);
      });

      it('Esc in filter mode clears query AND exits mode (D5-05)', () => {
        const ghosts = [makeGhost({ name: 'alpha', category: 'agent' })];
        const picker = makePicker(ghosts);
        fireKey(picker, '/');
        fireKey(picker, 'a');
        expect(picker.filterMode).toBe(true);
        expect(picker.filterSortByTab[0]!.query).toBe('a');
        fireKey(picker, undefined, { name: 'escape' });
        expect(picker.filterMode).toBe(false);
        expect(picker.filterSortByTab[0]!.query).toBe('');
        expect(picker.filterSortByTab[0]!.active).toBe(false);
      });

      it('Enter in filter mode exits mode but preserves query (D5-05)', () => {
        const ghosts = [
          makeGhost({ name: 'alpha', category: 'agent' }),
          makeGhost({ name: 'beta', category: 'agent' }),
        ];
        const picker = makePicker(ghosts);
        fireKey(picker, '/');
        fireKey(picker, 'a');
        fireKey(picker, 'l');
        fireKey(picker, undefined, { name: 'return' });
        expect(picker.filterMode).toBe(false);
        expect(picker.filterSortByTab[0]!.query).toBe('al');
        expect(picker.filterSortByTab[0]!.active).toBe(true);
        // List stays narrowed.
        const names = picker.visibleItemsForTab(0).map((x) => x.item.name);
        expect(names).toEqual(['alpha']);
      });

      it("'s' cycles sort per-tab (4 presses returns to tokens-desc, D5-10)", () => {
        const ghosts = [makeGhost({ name: 'a1', category: 'agent' })];
        const picker = makePicker(ghosts);
        expect(picker.filterSortByTab[0]!.sort).toBe('staleness-desc');
        fireKey(picker, 's');
        expect(picker.filterSortByTab[0]!.sort).toBe('tokens-desc');
        fireKey(picker, 's');
        expect(picker.filterSortByTab[0]!.sort).toBe('name-asc');
        fireKey(picker, 's');
        expect(picker.filterSortByTab[0]!.sort).toBe('staleness-desc');
        fireKey(picker, 's');
        expect(picker.filterSortByTab[0]!.sort).toBe('tokens-desc');
      });

      it("'s' while in filter mode is appended to query (NOT treated as sort)", () => {
        const ghosts = [makeGhost({ name: 'spam', category: 'agent' })];
        const picker = makePicker(ghosts);
        fireKey(picker, '/');
        fireKey(picker, 's');
        expect(picker.filterSortByTab[0]!.query).toBe('s');
        expect(picker.filterSortByTab[0]!.sort).toBe('staleness-desc');
      });

      it("footer shows 'Filtered: M of N visible · X selected' when filter active", () => {
        const ghosts = [
          makeGhost({ name: 'alpha', category: 'agent' }),
          makeGhost({ name: 'zzz', category: 'agent' }),
          makeGhost({ name: 'yyy', category: 'agent' }),
        ];
        const picker = makePicker(ghosts); // useAscii=true → '|' separator
        fireKey(picker, '/');
        fireKey(picker, 'a');
        const frame = picker._renderFrame();
        // Only 'alpha' contains 'a' → M=1, N=3, X=0
        expect(frame).toContain('Filtered: 1 of 3 visible | 0 selected');
      });

      it("footer shows '(incl. hidden)' when a selected id is not in any visible slice", () => {
        const ghosts = [
          makeGhost({ name: 'alpha', category: 'agent' }),
          makeGhost({ name: 'beta', category: 'agent' }),
        ];
        const picker = makePicker(ghosts);
        // Select 'beta' (cursor on first item which is 'alpha'; sort staleness
        // with no mtimeMs means both are equally stale — preserve input order,
        // so 'alpha' is at cursor 0).
        picker.cursorDown();
        picker.toggleCurrentRow(); // select 'beta'
        // Now filter to 'alp' — beta hidden.
        fireKey(picker, '/');
        fireKey(picker, 'a');
        fireKey(picker, 'l');
        fireKey(picker, 'p');
        const frame = picker._renderFrame();
        expect(frame).toContain('1 selected (incl. hidden)');
      });

      it("footer omits '(incl. hidden)' when all selections are in a visible slice", () => {
        const ghosts = [
          makeGhost({ name: 'alpha', category: 'agent' }),
          makeGhost({ name: 'beta', category: 'agent' }),
        ];
        const picker = makePicker(ghosts);
        picker.toggleCurrentRow(); // select 'alpha' (cursor 0)
        fireKey(picker, '/');
        fireKey(picker, 'a');
        const frame = picker._renderFrame();
        // Both 'alpha' and 'beta' start with no mtimeMs → staleness-desc leaves
        // input order. 'alpha' is visible, 'beta' is hidden but not selected.
        expect(frame).toContain('1 selected');
        expect(frame).not.toContain('(incl. hidden)');
      });

      it('sort label appears on header only when non-default (D5-12)', () => {
        const ghosts = [makeGhost({ name: 'a1', category: 'agent' })];
        const picker = makePicker(ghosts);
        // Default: no sort label.
        expect(picker._renderFrame()).not.toContain('sort:');
        fireKey(picker, 's'); // → tokens-desc
        expect(picker._renderFrame()).toContain('sort:tokens');
        fireKey(picker, 's'); // → name-asc
        expect(picker._renderFrame()).toContain('sort:name');
        fireKey(picker, 's'); // → staleness-desc (default)
        expect(picker._renderFrame()).not.toContain('sort:');
      });

      it('sanitization: pasted ANSI bytes are stripped from echoed query (T-05-01)', () => {
        const ghosts = [makeGhost({ name: 'foo', category: 'agent' })];
        const picker = makePicker(ghosts);
        fireKey(picker, '/');
        // Simulate pasting "\x1b[31mfoo" one character at a time through the
        // filter-append path. Each single-char codepoint < 32 is rejected by
        // the append guard. This covers the append-time mitigation. The
        // render-time mitigation additionally re-sanitizes, so if a future
        // code path bypasses append and writes a raw escape to state.query,
        // the rendered echo still has no escapes.
        // Direct state poisoning to exercise the render-time sanitizer:
        picker.filterSortByTab[0]!.query = '\x1b[31mfoo';
        picker.filterSortByTab[0]!.active = true;
        const frame = picker._renderFrame();
        // Echoed as 'Filter: foo_' — no ANSI in output (the plain "foo_"
        // sequence must appear).
        expect(frame).toContain('Filter: foo_');
        // Raw ESC byte must NOT be present.
        // eslint-disable-next-line no-control-regex
        expect(/\x1b/.test(frame)).toBe(false);
      });

      it('cursor clamps when s-cycle changes visible ordering', () => {
        const ghosts = [
          makeGhost({ name: 'a1', category: 'agent', tokens: 1 }),
          makeGhost({ name: 'a2', category: 'agent', tokens: 2 }),
          makeGhost({ name: 'a3', category: 'agent', tokens: 3 }),
        ];
        const picker = makePicker(ghosts);
        picker.cursorDown();
        picker.cursorDown();
        expect(picker.tabs[0]!.cursor).toBe(2);
        // Apply a filter that narrows to a single item.
        fireKey(picker, '/');
        fireKey(picker, 'a');
        fireKey(picker, '2');
        // Visible slice has 1 item — cursor clamps to 0.
        const frame = picker._renderFrame();
        expect(frame).toContain('Filtered: 1 of 3 visible');
        expect(picker.tabs[0]!.cursor).toBe(0);
      });
    });

    describe('Phase 5 help overlay — Plan 03 (D5-13..D5-16)', () => {
      it("'?' toggles helpOpen true/false", () => {
        const ghosts = [makeGhost({ name: 'a1', category: 'agent' })];
        const picker = makePicker(ghosts);
        expect(picker.helpOpen).toBe(false);
        fireKey(picker, '?');
        expect(picker.helpOpen).toBe(true);
        fireKey(picker, '?');
        expect(picker.helpOpen).toBe(false);
      });

      it('Esc closes the overlay (does NOT mutate filter query)', () => {
        const ghosts = [
          makeGhost({ name: 'alpha', category: 'agent' }),
          makeGhost({ name: 'beta', category: 'agent' }),
        ];
        const picker = makePicker(ghosts);
        // Set a filter first (Enter exits filter mode but keeps query active).
        fireKey(picker, '/');
        fireKey(picker, 'a');
        fireKey(picker, 'l');
        fireKey(picker, undefined, { name: 'return' });
        expect(picker.filterSortByTab[0]!.query).toBe('al');
        expect(picker.filterSortByTab[0]!.active).toBe(true);
        // Open help.
        fireKey(picker, '?');
        expect(picker.helpOpen).toBe(true);
        // Close with Esc — filter state intact.
        fireKey(picker, undefined, { name: 'escape' });
        expect(picker.helpOpen).toBe(false);
        expect(picker.filterSortByTab[0]!.query).toBe('al');
        expect(picker.filterSortByTab[0]!.active).toBe(true);
      });

      it('while help is open, printable keys / / / s / Space / arrows are all no-ops', () => {
        const ghosts = [
          makeGhost({ name: 'a1', category: 'agent' }),
          makeGhost({ name: 'a2', category: 'agent' }),
          makeGhost({ name: 's1', category: 'skill' }),
        ];
        const picker = makePicker(ghosts);
        const beforeCursor = picker.tabs[0]!.cursor;
        const beforeTab = picker.activeTabIndex;
        const beforeSort = picker.filterSortByTab[0]!.sort;
        const beforeSelected = picker.selectedIds.size;
        fireKey(picker, '?');
        expect(picker.helpOpen).toBe(true);
        // Printable keys that normally navigate / toggle / sort / filter:
        fireKey(picker, '/');
        fireKey(picker, 's');
        fireKey(picker, 'a');
        fireKey(picker, '2');
        fireKey(picker, 'x');
        // Cursor actions (space/arrows/enter/tab).
        (picker as unknown as { emit: (e: string, ...a: unknown[]) => boolean }).emit(
          'cursor',
          'down',
        );
        (picker as unknown as { emit: (e: string, ...a: unknown[]) => boolean }).emit(
          'cursor',
          'space',
        );
        (picker as unknown as { emit: (e: string, ...a: unknown[]) => boolean }).emit(
          'cursor',
          'right',
        );
        // Nothing mutated.
        expect(picker.helpOpen).toBe(true);
        expect(picker.tabs[0]!.cursor).toBe(beforeCursor);
        expect(picker.activeTabIndex).toBe(beforeTab);
        expect(picker.filterSortByTab[0]!.sort).toBe(beforeSort);
        expect(picker.selectedIds.size).toBe(beforeSelected);
        expect(picker.filterMode).toBe(false);
      });

      it('open+close overlay preserves selectedIds, activeTabIndex, per-tab cursor, filter/sort (D5-13)', () => {
        const ghosts = [
          makeGhost({ name: 'a1', category: 'agent' }),
          makeGhost({ name: 'a2', category: 'agent' }),
          makeGhost({ name: 's1', category: 'skill' }),
          makeGhost({ name: 's2', category: 'skill' }),
        ];
        const picker = makePicker(ghosts);
        // Build some state: select a1, move cursor, switch tab, cycle sort.
        picker.toggleCurrentRow(); // select a1
        picker.cursorDown();
        picker.nextTab(); // tab=1 (SKILLS)
        picker.toggleCurrentRow(); // select s1
        fireKey(picker, 's'); // tokens-desc on skills
        const snapSelected = new Set(picker.selectedIds);
        const snapTab = picker.activeTabIndex;
        const snapCursor0 = picker.tabs[0]!.cursor;
        const snapCursor1 = picker.tabs[1]!.cursor;
        const snapSort0 = picker.filterSortByTab[0]!.sort;
        const snapSort1 = picker.filterSortByTab[1]!.sort;
        // Open + close via `?`.
        fireKey(picker, '?');
        fireKey(picker, '?');
        expect(picker.helpOpen).toBe(false);
        expect(Array.from(picker.selectedIds).sort()).toEqual(Array.from(snapSelected).sort());
        expect(picker.activeTabIndex).toBe(snapTab);
        expect(picker.tabs[0]!.cursor).toBe(snapCursor0);
        expect(picker.tabs[1]!.cursor).toBe(snapCursor1);
        expect(picker.filterSortByTab[0]!.sort).toBe(snapSort0);
        expect(picker.filterSortByTab[1]!.sort).toBe(snapSort1);
      });

      it('cursor `cancel` action is still honored while help is open (INV-S2 / T-05-02)', () => {
        const ghosts = [makeGhost({ name: 'a1', category: 'agent' })];
        const picker = makePicker(ghosts);
        fireKey(picker, '?');
        expect(picker.helpOpen).toBe(true);
        // Drive the cursor dispatcher with 'cancel'; the gate must NOT swallow it.
        let cancelRan = false;
        const origCancel = picker.cancel.bind(picker);
        (picker as unknown as { cancel: () => void }).cancel = () => {
          cancelRan = true;
          // Do NOT call origCancel — it flips state and would race the test.
          // Reference origCancel to satisfy TS no-unused-expressions lint.
          void origCancel;
        };
        (picker as unknown as { emit: (e: string, ...a: unknown[]) => boolean }).emit(
          'cursor',
          'cancel',
        );
        expect(cancelRan).toBe(true);
      });

      it('_renderFrame returns help overlay content when helpOpen is true', () => {
        const ghosts = [makeGhost({ name: 'a1', category: 'agent' })];
        const picker = makePicker(ghosts);
        fireKey(picker, '?');
        const frame = picker._renderFrame();
        // Heading + representative keybind.
        expect(frame).toContain('Navigation');
        expect(frame).toContain('Selection');
        expect(frame).toContain('View');
        expect(frame).toContain('Exit');
        // Does NOT render the tab bar / per-tab header while overlay is up.
        expect(frame).not.toContain('AGENTS (0/1)');
      });

      it('`?` opens help from inside filter mode (Claude Discretion routing)', () => {
        const ghosts = [makeGhost({ name: 'alpha', category: 'agent' })];
        const picker = makePicker(ghosts);
        fireKey(picker, '/');
        expect(picker.filterMode).toBe(true);
        fireKey(picker, '?');
        expect(picker.helpOpen).toBe(true);
        // Filter mode was not implicitly closed — user returns to filter on close.
        expect(picker.filterMode).toBe(true);
      });
    });
  });
}

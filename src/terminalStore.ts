import { Channel, invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { builtinAppearance, resolveAppearance, terminalTheme } from "./appearance";
import { t, translateBackend } from "./i18n";
import { DEFAULT_TERMINAL_FONT, fontStack } from "./fonts";
import { decodeOsc52, encodeOsc52 } from "./osc52";
import { comboFromEvent, KEY_ACTIONS, primaryCombo, resolveKeybindings, type KeyAction, type Keybindings } from "./keybindings";
import type { Appearance, ClipboardReadMode, PendingClipboardRead, PendingPaste, SavedHost, SessionEvent, SessionStatus, SplitDirection, SplitTarget, TabKind, TerminalContextMenu, TerminalPaneState, TerminalSnapshot, TerminalTab } from "./terminalTypes";

const initialSnapshot: TerminalSnapshot = { tabs: [], activeTabId: null, pendingPaste: null, contextMenu: null, pendingClipboardRead: null };

type ClipboardPreferences = {
  copyOnSelect: boolean;
  confirmMultilinePaste: boolean;
  forceMouseSelection: boolean;
  allowClipboardWrite: boolean;
  clipboardRead: ClipboardReadMode;
};

/** write_to_session accepts at most 64 KiB per call. */
const MAX_WRITE_BYTES = 32 * 1024;
/** Each tab holds at most this many panes for now. */
const MAX_PANES = 2;
/** Same limit as the backend (session.json). */
export const MAX_TAB_TITLE_CHARS = 64;
/** Per-tab zoom (Ctrl+Plus / Ctrl+Minus) in font pixels on top of the design's font size. */
const MIN_ZOOM = -8;
const MAX_ZOOM = 16;
const MIN_FONT_SIZE = 6;
export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;

/** A text field outside the terminals has the keyboard focus. */
function isEditingText(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && !active.closest(".xterm") && active.matches("input, textarea, select, [contenteditable='true']");
}

/** Live objects of one pane: its xterm instance and its session. */
type PaneRuntime = {
  tabId: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLElement | null;
  observer: ResizeObserver | null;
  opened: boolean;
  sessionId: string | null;
  connectPromise: Promise<void> | null;
  closing: boolean;
  selectionTimer: number | null;
  /** The user allowed OSC 52 clipboard reads for the current session. */
  clipboardReadAllowed: boolean;
  /** Keeps terminal input in order, e.g. a pasted snippet before the Enter that runs it. */
  writeChain: Promise<void>;
  /**
   * The session starts on the first fit, i.e. once the terminal is visible and has its real size.
   * Started earlier, programs such as fastfetch format their output for 80 columns and it wraps
   * badly after the resize. Tabs restored in the background therefore connect when first shown.
   */
  startOnFit: boolean;
};

/** Copies the active pane's fields onto the tab, so tab-level UI shows the focused pane. */
function withActivePane(tab: TerminalTab): TerminalTab {
  const active = tab.panes.find((pane) => pane.id === tab.activePaneId) ?? tab.panes[0];
  return {
    ...tab,
    activePaneId: active.id,
    kind: active.kind,
    title: active.title,
    server: active.server,
    status: active.status,
    notice: active.notice,
    appearance: active.appearance,
  };
}

class TerminalStore {
  private tabs: TerminalTab[] = [];
  private activeTabId: string | null = null;
  /** Keyed by pane id. */
  private runtimes = new Map<string, PaneRuntime>();
  private listeners = new Set<() => void>();
  private snapshot = initialSnapshot;
  private clipboardPreferences: ClipboardPreferences = {
    copyOnSelect: true,
    confirmMultilinePaste: true,
    forceMouseSelection: false,
    allowClipboardWrite: true,
    clipboardRead: "ask",
  };
  private pendingPaste: PendingPaste | null = null;
  private snippetShortcutHandler: (() => void) | null = null;
  private sidebarShortcutHandler: (() => void) | null = null;
  private newTabShortcutHandler: (() => void) | null = null;
  private splitShortcutHandler: ((direction: SplitDirection, at: { x: number; y: number } | null) => void) | null = null;
  private contextMenu: TerminalContextMenu | null = null;
  private pendingClipboardRead: (PendingClipboardRead & { target: string }) | null = null;
  private appearances: Appearance[] = [builtinAppearance];
  private terminalFont = DEFAULT_TERMINAL_FONT;
  private defaultAppearanceId = builtinAppearance.id;
  private localAppearanceId = "";
  private bindings = resolveKeybindings(undefined);
  /** Combo string (see comboFromEvent) → action. */
  private keyMap = new Map<string, KeyAction>();

  constructor() {
    this.setKeybindings(undefined);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TerminalSnapshot => this.snapshot;

  /** Called when Ctrl+Shift+S is pressed inside a terminal. */
  onSnippetShortcut(handler: (() => void) | null): void {
    this.snippetShortcutHandler = handler;
  }

  /** Ctrl+Shift+B (by default): show or hide the server sidebar. */
  onSidebarShortcut(handler: (() => void) | null): void {
    this.sidebarShortcutHandler = handler;
  }

  /** Ctrl+Shift+N (by default): choose what a new tab opens. */
  onNewTabShortcut(handler: (() => void) | null): void {
    this.newTabShortcutHandler = handler;
  }

  /** Optional: lets the UI handle the split shortcuts; without it they split with the same target. */
  onSplitShortcut(handler: ((direction: SplitDirection, at: { x: number; y: number } | null) => void) | null): void {
    this.splitShortcutHandler = handler;
  }

  // ---------------------------------------------------------------- lookups

  private tabOf(paneId: string): TerminalTab | undefined {
    return this.tabs.find((tab) => tab.panes.some((pane) => pane.id === paneId));
  }

  private paneState(paneId: string): TerminalPaneState | undefined {
    return this.tabOf(paneId)?.panes.find((pane) => pane.id === paneId);
  }

  /** The focused pane of the active tab. */
  private activePaneId(): string | null {
    const tab = this.tabs.find((item) => item.id === this.activeTabId);
    return tab?.activePaneId ?? null;
  }

  private activePaneOfTab(tabId: string): string | null {
    return this.tabs.find((tab) => tab.id === tabId)?.activePaneId ?? null;
  }

  // ---------------------------------------------------------------- context menu

  closeContextMenu(focus = true): void {
    const menu = this.contextMenu;
    if (!menu) return;
    this.contextMenu = null;
    this.publish();
    if (focus) this.runtimes.get(menu.paneId)?.terminal.focus();
  }

  runContextAction(action: "copy" | "paste" | "selectAll" | "snippets" | "splitRow" | "splitColumn" | "closePane"): void {
    const menu = this.contextMenu;
    if (!menu) return;
    const keepsFocus = action === "copy" || action === "paste" || action === "selectAll";
    this.closeContextMenu(keepsFocus);
    const runtime = this.runtimes.get(menu.paneId);
    if (!runtime) return;
    this.focusPane(menu.paneId);
    if (action === "copy") void this.copySelection(menu.paneId);
    else if (action === "paste") void this.pasteFromClipboard(menu.paneId);
    else if (action === "selectAll") runtime.terminal.selectAll();
    else if (action === "splitRow" || action === "splitColumn") this.requestSplit(action === "splitRow" ? "row" : "column", { x: menu.x, y: menu.y });
    else if (action === "closePane") void this.closePane(menu.paneId);
    else this.snippetShortcutHandler?.();
  }

  private requestSplit(direction: SplitDirection, at: { x: number; y: number } | null): void {
    if (this.splitShortcutHandler) this.splitShortcutHandler(direction, at);
    else this.splitActiveTab(direction, { kind: "same" });
  }

  // ---------------------------------------------------------------- input, snippets, clipboard

  /** Whether the active pane has a connected session that can receive input. */
  canSendToActiveTab(): boolean {
    const paneId = this.activePaneId();
    return paneId !== null && this.canSendInput(paneId);
  }

  focusActiveTerminal(): void {
    const paneId = this.activePaneId();
    if (paneId) this.runtimes.get(paneId)?.terminal.focus();
  }

  /**
   * Pastes a snippet into the active pane (never sends it on its own). Trailing line
   * breaks are removed first; multiline snippets always need a confirmation.
   * With `execute`, Enter is sent afterwards. Returns false when no session is connected.
   */
  insertSnippet(text: string, execute: boolean): boolean {
    const paneId = this.activePaneId();
    const trimmed = text.replace(/[\r\n]+$/, "");
    if (!paneId || !this.canSendInput(paneId)) {
      if (paneId) this.updatePane(paneId, { notice: t("notice.snippetNoSession") });
      return false;
    }
    if (!trimmed) return true;
    if (/[\r\n]/.test(trimmed)) {
      this.pendingPaste = { tabId: this.tabOf(paneId)?.id ?? "", paneId, text: trimmed, source: "snippet", execute };
      this.publish();
      return true;
    }
    this.pasteNow(paneId, trimmed, execute);
    return true;
  }

  private pasteNow(paneId: string, text: string, execute: boolean): void {
    const runtime = this.runtimes.get(paneId);
    if (!runtime || !this.canSendInput(paneId)) return;
    // paste() applies bracketed paste mode and emits onData synchronously,
    // so the Enter below is queued after the pasted text.
    runtime.terminal.paste(text);
    if (execute) this.sendInput(paneId, "\r");
    runtime.terminal.focus();
  }

  /** Sends input to the pane's session the same way keystrokes are sent. */
  private sendInput(paneId: string, data: string): void {
    const runtime = this.runtimes.get(paneId);
    const sessionId = runtime?.sessionId;
    if (!runtime || !sessionId || !this.canSendInput(paneId)) return;
    const bytes = new TextEncoder().encode(data);
    for (let offset = 0; offset < bytes.length; offset += MAX_WRITE_BYTES) {
      const chunk = bytes.slice(offset, offset + MAX_WRITE_BYTES);
      runtime.writeChain = runtime.writeChain
        .then(() => invoke<void>("write_to_session", chunk, { headers: { "x-session-id": sessionId } }))
        .catch((error: unknown) => this.updatePane(paneId, { notice: translateBackend(error) }));
    }
  }

  /** OSC 52 query from a program: answer per the user's setting, or ask first. */
  private handleClipboardRead(paneId: string, target: string): void {
    const runtime = this.runtimes.get(paneId);
    if (!runtime || !this.canSendInput(paneId)) return;
    const mode = this.clipboardPreferences.clipboardRead;
    if (mode === "never") {
      this.replyClipboard(paneId, target, "");
    } else if (mode === "always" || runtime.clipboardReadAllowed) {
      void this.replyWithClipboard(paneId, target);
    } else if (!this.pendingClipboardRead) {
      this.pendingClipboardRead = { tabId: runtime.tabId, paneId, target };
      this.publish();
    }
  }

  /** "deny" answers with an empty clipboard; "session" allows reads until the session ends. */
  answerClipboardRead(decision: "deny" | "session"): void {
    const pending = this.pendingClipboardRead;
    if (!pending) return;
    this.pendingClipboardRead = null;
    this.publish();
    const runtime = this.runtimes.get(pending.paneId);
    if (!runtime) return;
    if (decision === "deny") {
      this.replyClipboard(pending.paneId, pending.target, "");
    } else {
      runtime.clipboardReadAllowed = true;
      // Programs that wait (e.g. Neovim) get the answer now. micro gives up after 200 ms and
      // drops late answers, so the user presses Ctrl+V again; that one is answered at once.
      void this.replyWithClipboard(pending.paneId, pending.target);
      this.updatePane(pending.paneId, { notice: t("notice.clipboardReadAllowed") });
    }
    runtime.terminal.focus();
  }

  private async replyWithClipboard(paneId: string, target: string): Promise<void> {
    try {
      this.replyClipboard(paneId, target, (await readText()) ?? "");
    } catch (error) {
      this.replyClipboard(paneId, target, "");
      this.updatePane(paneId, { notice: t("notice.pasteFailed", { error: translateBackend(error) }) });
    }
  }

  private replyClipboard(paneId: string, target: string, text: string): void {
    // Terminated with ST (ESC + backslash): tcell (micro) does not accept BEL here.
    this.sendInput(paneId, encodeOsc52(target, text));
  }

  setClipboardPreferences(preferences: ClipboardPreferences): void {
    this.clipboardPreferences = preferences;
  }

  setAppearances(appearances: Appearance[], defaultAppearanceId: string, localAppearanceId: string): void {
    this.appearances = appearances;
    this.defaultAppearanceId = defaultAppearanceId;
    this.localAppearanceId = localAppearanceId;
    for (const tab of this.tabs) for (const pane of tab.panes) this.applyAppearance(pane.id);
  }

  /** Terminal font from Settings → Fonts ("" = default); applies to open terminals too. */
  setTerminalFont(name: string): void {
    const font = fontStack(name, DEFAULT_TERMINAL_FONT);
    if (font === this.terminalFont) return;
    this.terminalFont = font;
    for (const [paneId, runtime] of this.runtimes) {
      runtime.terminal.options.fontFamily = font;
      // Other glyph widths change the cell grid, so the PTY needs the new dimensions.
      requestAnimationFrame(() => this.fitPane(paneId));
    }
  }

  /** Ctrl+Plus / Ctrl+Minus: `step` font pixels for every pane of the tab; 0 resets. */
  zoomTab(tabId: string, step: number): void {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    const fontZoom = step === 0 ? 0 : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, tab.fontZoom + step));
    if (fontZoom === tab.fontZoom) return;
    this.tabs = this.tabs.map((item) => item.id === tabId ? { ...item, fontZoom } : item);
    for (const pane of tab.panes) this.applyAppearance(pane.id);
    this.publish();
  }

  /** The design's font size plus the tab zoom. */
  private fontSizeFor(tabId: string, appearance: Appearance): number {
    const zoom = this.tabs.find((tab) => tab.id === tabId)?.fontZoom ?? 0;
    return Math.max(MIN_FONT_SIZE, appearance.fontSize + zoom);
  }

  /** Keeps open panes in sync after server profiles were edited or removed. */
  updateServers(servers: SavedHost[]): void {
    for (const tab of this.tabs) {
      for (const pane of tab.panes) {
        if (!pane.server) continue;
        const updated = servers.find((server) => server.id === pane.server?.id);
        if (!updated) continue;
        this.updatePane(pane.id, { server: updated, title: this.serverTitle(updated) });
        this.applyAppearance(pane.id);
      }
    }
  }

  private applyAppearance(paneId: string): void {
    const pane = this.paneState(paneId);
    const runtime = this.runtimes.get(paneId);
    if (!pane || !runtime) return;
    const appearance = this.appearanceFor(pane.kind, pane.server);
    runtime.terminal.options.theme = terminalTheme(appearance);
    const fontSize = this.fontSizeFor(runtime.tabId, appearance);
    if (runtime.terminal.options.fontSize !== fontSize) {
      runtime.terminal.options.fontSize = fontSize;
      // A new font size changes the cell grid, so the PTY needs the new dimensions.
      requestAnimationFrame(() => this.fitPane(paneId));
    }
    if (pane.appearance !== appearance) this.updatePane(paneId, { appearance });
  }

  /** Copies the selection of a pane (default: the active one). */
  async copySelection(paneId: string | null = this.activePaneId()): Promise<void> {
    const runtime = paneId ? this.runtimes.get(paneId) : undefined;
    const selection = runtime?.terminal.getSelection();
    if (!paneId || !runtime || !selection) return;
    try {
      await writeText(selection);
      this.updatePane(paneId, { notice: t("notice.copied") });
    } catch (error) {
      this.updatePane(paneId, { notice: t("notice.copyFailed", { error: translateBackend(error) }) });
    }
  }

  /** Pastes the clipboard into a pane (default: the active one). */
  async pasteFromClipboard(paneId: string | null = this.activePaneId()): Promise<void> {
    const runtime = paneId ? this.runtimes.get(paneId) : undefined;
    if (!paneId || !runtime || runtime.closing) return;
    try {
      const text = await readText();
      if (text) this.pasteText(paneId, text);
    } catch (error) {
      this.updatePane(paneId, { notice: t("notice.pasteFailed", { error: translateBackend(error) }) });
    }
  }

  /** Routes every paste (shortcut, context menu, middle click) through the multiline check. */
  private pasteText(paneId: string, text: string): void {
    const runtime = this.runtimes.get(paneId);
    if (!runtime || runtime.closing || !text) return;
    if (!this.canSendInput(paneId)) {
      this.updatePane(paneId, { notice: t("notice.pasteNoSession") });
      return;
    }
    if (this.clipboardPreferences.confirmMultilinePaste && /[\r\n]/.test(text)) {
      this.pendingPaste = { tabId: runtime.tabId, paneId, text, source: "clipboard", execute: false };
      this.publish();
      return;
    }
    runtime.terminal.paste(text);
  }

  confirmPendingPaste(): void {
    const pending = this.pendingPaste;
    if (!pending) return;
    this.pendingPaste = null;
    this.publish();
    const runtime = this.runtimes.get(pending.paneId);
    if (!runtime || runtime.closing) return;
    if (this.canSendInput(pending.paneId)) {
      this.pasteNow(pending.paneId, pending.text, pending.execute);
    } else {
      this.updatePane(pending.paneId, { notice: t(pending.source === "snippet" ? "notice.snippetNoSession" : "notice.pasteNoSession") });
      runtime.terminal.focus();
    }
  }

  cancelPendingPaste(): void {
    const pending = this.pendingPaste;
    if (!pending) return;
    this.pendingPaste = null;
    this.publish();
    this.runtimes.get(pending.paneId)?.terminal.focus();
  }

  private canSendInput(paneId: string): boolean {
    const runtime = this.runtimes.get(paneId);
    const pane = this.paneState(paneId);
    return Boolean(runtime && !runtime.closing && runtime.sessionId && pane?.status === "connected");
  }

  private appearanceFor(kind: TabKind, server: SavedHost | null): Appearance {
    const preferredId = kind === "local" ? this.localAppearanceId : server?.appearanceId ?? "";
    return resolveAppearance(preferredId, this.appearances, this.defaultAppearanceId);
  }

  // ---------------------------------------------------------------- tabs and panes

  /** Opens a new tab running the user's local login shell. */
  openLocalShell(): string {
    return this.createTab(null);
  }

  /** Opens a new tab and connects it to the given server over SSH. */
  openServer(server: SavedHost): string {
    return this.createTab(server);
  }

  /** `server === null` creates a local shell tab. */
  private createTab(server: SavedHost | null): string {
    const id = crypto.randomUUID();
    const pane = this.createPane(id, server);
    this.tabs = [...this.tabs, withActivePane({
      id,
      panes: [pane],
      split: null,
      splitRatio: 0.5,
      activePaneId: pane.id,
      customTitle: "",
      customColor: "",
      fontZoom: 0,
      kind: pane.kind,
      title: pane.title,
      server: pane.server,
      status: pane.status,
      notice: pane.notice,
      appearance: pane.appearance,
    })];
    this.activateTab(id);
    return id;
  }

  /**
   * Splits the active tab: "row" puts the new pane on the right, "column" below.
   * A tab that is already split only changes its direction (two panes for now).
   * Returns the new pane id, or null when nothing was added.
   */
  splitActiveTab(direction: SplitDirection, target: SplitTarget): string | null {
    const tab = this.tabs.find((item) => item.id === this.activeTabId);
    return tab ? this.splitTab(tab.id, direction, target) : null;
  }

  splitTab(tabId: string, direction: SplitDirection, target: SplitTarget): string | null {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) return null;
    if (tab.panes.length >= MAX_PANES) {
      this.setSplitDirection(tabId, direction);
      return null;
    }
    const source = tab.panes.find((pane) => pane.id === tab.activePaneId) ?? tab.panes[0];
    const server = target.kind === "server" ? target.server : target.kind === "local" ? null : source.server;
    const pane = this.createPane(tabId, server);
    this.tabs = this.tabs.map((item) => item.id === tabId
      ? withActivePane({ ...item, panes: [...item.panes, pane], split: direction, splitRatio: 0.5, activePaneId: pane.id })
      : item);
    this.publish();
    this.refitTab(tabId, pane.id);
    return pane.id;
  }

  /** Gives a tab its own name; an empty name goes back to the automatic title. */
  renameTab(tabId: string, title: string): void {
    const customTitle = [...title.replace(/[\u0000-\u001f\u007f]/g, "").trim()].slice(0, MAX_TAB_TITLE_CHARS).join("");
    this.patchTab(tabId, { customTitle });
  }

  /** Own color for a tab ("#rrggbb"); an empty value goes back to the design's tab color. */
  setTabColor(tabId: string, color: string): void {
    this.patchTab(tabId, { customColor: /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : "" });
  }

  /** Tab-level fields only (name, color); pane fields go through updatePane. */
  private patchTab(tabId: string, patch: Partial<Pick<TerminalTab, "customTitle" | "customColor">>): void {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab || Object.entries(patch).every(([key, value]) => tab[key as keyof typeof patch] === value)) return;
    this.tabs = this.tabs.map((item) => item.id === tabId ? { ...item, ...patch } : item);
    this.publish();
  }

  setSplitDirection(tabId: string, direction: SplitDirection): void {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab || tab.panes.length < 2 || tab.split === direction) return;
    this.tabs = this.tabs.map((item) => item.id === tabId ? { ...item, split: direction } : item);
    this.publish();
    this.refitTab(tabId);
  }

  /** Moves a tab to a new position in the tab strip (index in the list without the tab). */
  moveTab(tabId: string, toIndex: number): void {
    const index = this.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const rest = this.tabs.filter((tab) => tab.id !== tabId);
    const target = Math.max(0, Math.min(rest.length, toIndex));
    if (target === index) return;
    this.tabs = [...rest.slice(0, target), this.tabs[index], ...rest.slice(target)];
    this.publish();
  }

  /** Both tabs have a single pane, so they can be merged into one split tab. */
  canMergeTabs(sourceTabId: string, targetTabId: string): boolean {
    const source = this.tabs.find((tab) => tab.id === sourceTabId);
    const target = this.tabs.find((tab) => tab.id === targetTabId);
    return Boolean(source && target && source !== target && source.panes.length + target.panes.length <= MAX_PANES);
  }

  /**
   * Moves the source tab's terminal into the target tab as a split pane (drag and drop).
   * `first` puts it left/top, otherwise right/bottom. The session keeps running.
   */
  mergeTabs(sourceTabId: string, targetTabId: string, direction: SplitDirection, first: boolean): void {
    if (!this.canMergeTabs(sourceTabId, targetTabId)) return;
    const source = this.tabs.find((tab) => tab.id === sourceTabId)!;
    const moved = source.panes[0];
    const runtime = this.runtimes.get(moved.id);
    if (!runtime || runtime.closing) return;
    runtime.tabId = targetTabId;
    if (this.pendingPaste?.paneId === moved.id) this.pendingPaste = { ...this.pendingPaste, tabId: targetTabId };
    if (this.pendingClipboardRead?.paneId === moved.id) this.pendingClipboardRead = { ...this.pendingClipboardRead, tabId: targetTabId };
    this.contextMenu = null;
    this.tabs = this.tabs
      .filter((tab) => tab.id !== sourceTabId)
      .map((tab) => tab.id === targetTabId
        ? withActivePane({ ...tab, panes: first ? [moved, ...tab.panes] : [...tab.panes, moved], split: direction, splitRatio: 0.5, activePaneId: moved.id })
        : tab);
    this.activeTabId = targetTabId;
    this.publish();
    this.refitTab(targetTabId, moved.id);
  }

  /** Takes a pane out of a split tab and opens it as its own tab next to it; the session keeps running. */
  detachPane(paneId: string): void {
    const tab = this.tabOf(paneId);
    const runtime = this.runtimes.get(paneId);
    if (!tab || !runtime || tab.panes.length < 2) return;
    const pane = tab.panes.find((item) => item.id === paneId)!;
    const newTabId = crypto.randomUUID();
    runtime.tabId = newTabId;
    if (this.pendingPaste?.paneId === paneId) this.pendingPaste = { ...this.pendingPaste, tabId: newTabId };
    if (this.pendingClipboardRead?.paneId === paneId) this.pendingClipboardRead = { ...this.pendingClipboardRead, tabId: newTabId };
    this.contextMenu = null;
    const remaining = tab.panes.filter((item) => item.id !== paneId);
    const index = this.tabs.findIndex((item) => item.id === tab.id);
    const updated = withActivePane({ ...tab, panes: remaining, split: null, activePaneId: remaining[0].id });
    const created = withActivePane({ ...updated, id: newTabId, panes: [pane], activePaneId: pane.id, splitRatio: 0.5, customTitle: "", customColor: "", fontZoom: 0 });
    this.tabs = [...this.tabs.slice(0, index), updated, created, ...this.tabs.slice(index + 1)];
    this.activateTab(newTabId);
  }

  /** Divider position; the ResizeObservers refit both panes. */
  setSplitRatio(tabId: string, ratio: number): void {
    const clamped = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab || Math.abs(tab.splitRatio - clamped) < 0.001) return;
    this.tabs = this.tabs.map((item) => item.id === tabId ? { ...item, splitRatio: clamped } : item);
    this.publish();
  }

  /** Makes a pane the focused one of its tab (click, focus, context menu). */
  focusPane(paneId: string, moveFocus = false): void {
    const tab = this.tabOf(paneId);
    if (!tab) return;
    if (tab.activePaneId !== paneId) {
      this.tabs = this.tabs.map((item) => item.id === tab.id ? withActivePane({ ...item, activePaneId: paneId }) : item);
      this.publish();
    }
    if (moveFocus) this.runtimes.get(paneId)?.terminal.focus();
  }

  private createPane(tabId: string, server: SavedHost | null): TerminalPaneState {
    const id = crypto.randomUUID();
    const kind: TabKind = server ? "ssh" : "local";
    const appearance = this.appearanceFor(kind, server);
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      convertEol: false,
      fontFamily: this.terminalFont,
      fontSize: this.fontSizeFor(tabId, appearance),
      lineHeight: 1.35,
      scrollback: 4000,
      theme: terminalTheme(appearance),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    // No WebGL addon: under WebKitGTK it drew missing or pixelated glyphs until a tab switch.

    const runtime: PaneRuntime = {
      tabId,
      terminal,
      fitAddon,
      element: null,
      observer: null,
      opened: false,
      sessionId: null,
      connectPromise: null,
      closing: false,
      selectionTimer: null,
      clipboardReadAllowed: false,
      writeChain: Promise.resolve(),
      startOnFit: true,
    };
    this.runtimes.set(id, runtime);
    terminal.attachCustomKeyEventHandler((event) => this.handleTerminalKey(event, id));
    // OSC 52: programs (micro with clipboard = terminal, vim, tmux, ...) set the clipboard.
    terminal.parser.registerOscHandler(52, (data) => {
      if (this.runtimes.get(id) !== runtime) return true;
      const [rawTarget, payload] = data.split(";", 2);
      if (payload === "?") {
        // Only answer for plain selection targets; never echo arbitrary program input.
        this.handleClipboardRead(id, /^[cpqs0-7]{0,8}$/.test(rawTarget) && rawTarget ? rawTarget : "c");
        return true;
      }
      if (!this.clipboardPreferences.allowClipboardWrite) return true;
      const text = decodeOsc52(data);
      // An empty payload means "clear"; ignore it rather than wiping the user's clipboard.
      if (text) {
        void writeText(text)
          .then(() => this.updatePane(id, { notice: t("notice.programCopied") }))
          .catch((error: unknown) => this.updatePane(id, { notice: t("notice.copyFailed", { error: translateBackend(error) }) }));
      }
      return true;
    });
    terminal.onSelectionChange(() => {
      if (!this.clipboardPreferences.copyOnSelect) return;
      if (runtime.selectionTimer !== null) window.clearTimeout(runtime.selectionTimer);
      // Debounce so dragging a selection writes the clipboard once, not on every mouse move.
      runtime.selectionTimer = window.setTimeout(() => {
        runtime.selectionTimer = null;
        const selection = terminal.getSelection();
        if (selection && this.runtimes.get(id) === runtime) {
          void writeText(selection).catch((error: unknown) => {
            this.updatePane(id, { notice: t("notice.copyFailed", { error: translateBackend(error) }) });
          });
        }
      }, 150);
    });
    terminal.onData((data) => {
      if (this.runtimes.get(id) === runtime) this.sendInput(id, data);
    });

    return {
      id,
      kind,
      // Local panes get their (translated) title at render time.
      title: server ? this.serverTitle(server) : "",
      server,
      status: "disconnected",
      notice: "",
      appearance,
    };
  }

  activateTab(tabId: string): void {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    this.activeTabId = tabId;
    this.publish();
    this.refitTab(tabId, tab.activePaneId);
  }

  /** Fits every pane of a tab after layout changes; optionally focuses one pane. */
  private refitTab(tabId: string, focusPaneId?: string): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const tab = this.tabs.find((item) => item.id === tabId);
        for (const pane of tab?.panes ?? []) this.fitPane(pane.id);
      });
      // Do not steal the focus from a text field that opened meanwhile (e.g. renaming the tab
      // by double-click: the first click activates the tab, the second opens the name field).
      if (focusPaneId && !isEditingText()) this.runtimes.get(focusPaneId)?.terminal.focus();
    });
  }

  getTerminal(tabId: string, paneId: string): Terminal | null {
    const runtime = this.runtimes.get(paneId);
    return runtime && runtime.tabId === tabId ? runtime.terminal : null;
  }

  attachPane(tabId: string, paneId: string, element: HTMLElement): () => void {
    const terminal = this.getTerminal(tabId, paneId);
    const runtime = this.runtimes.get(paneId);
    if (!terminal || !runtime) return () => undefined;

    runtime.element = element;
    if (!runtime.opened) {
      terminal.open(element);
      runtime.opened = true;
    } else if (terminal.element && terminal.element.parentElement !== element) {
      // The pane moved to another tab (drag and drop, detach): move xterm's DOM along.
      element.appendChild(terminal.element);
      requestAnimationFrame(() => terminal.refresh(0, terminal.rows - 1));
    }

    runtime.observer?.disconnect();
    runtime.observer = new ResizeObserver(() => this.fitPane(paneId));
    runtime.observer.observe(element);
    if (this.activeTabId === tabId) {
      requestAnimationFrame(() => requestAnimationFrame(() => this.fitPane(paneId)));
    }

    // Clicking or tabbing into a pane makes it the active one (title, status, snippets, shortcuts).
    const onFocusIn = () => this.focusPane(paneId);
    element.addEventListener("focusin", onFocusIn);

    // Capture native paste events (context menu, middle click) before xterm's own
    // textarea handler sends them unchecked, so they share the multiline confirmation.
    const onNativePaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text) this.pasteText(paneId, text);
    };
    element.addEventListener("paste", onNativePaste, true);

    // Mouse handling runs in the capture phase, before xterm forwards events to programs
    // that enabled mouse tracking (micro, htop, mc, ...).
    const onMouseDown = (event: MouseEvent) => {
      this.focusPane(paneId);
      if (event.button === 2) {
        // Right-click always belongs to the Crabshell menu, not to the program.
        event.stopPropagation();
        return;
      }
      if (
        event.button === 0 &&
        event.isTrusted &&
        !event.shiftKey &&
        this.clipboardPreferences.forceMouseSelection &&
        terminal.modes.mouseTrackingMode !== "none" &&
        event.target instanceof Element
      ) {
        // xterm selects instead of reporting the click when Shift is held, so replay the
        // click with Shift set.
        event.stopPropagation();
        event.preventDefault();
        event.target.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          detail: event.detail,
          screenX: event.screenX,
          screenY: event.screenY,
          clientX: event.clientX,
          clientY: event.clientY,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          shiftKey: true,
          button: event.button,
          buttons: event.buttons,
        }));
      }
    };
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      this.contextMenu = {
        tabId,
        paneId,
        split: (this.tabs.find((tab) => tab.id === tabId)?.panes.length ?? 1) > 1,
        x: event.clientX,
        y: event.clientY,
        hasSelection: terminal.hasSelection(),
        canPaste: this.canSendInput(paneId),
      };
      this.publish();
    };
    element.addEventListener("mousedown", onMouseDown, true);
    element.addEventListener("contextmenu", onContextMenu, true);

    return () => {
      element.removeEventListener("focusin", onFocusIn);
      element.removeEventListener("paste", onNativePaste, true);
      element.removeEventListener("mousedown", onMouseDown, true);
      element.removeEventListener("contextmenu", onContextMenu, true);
      if (runtime.element !== element) return;
      runtime.observer?.disconnect();
      runtime.observer = null;
      runtime.element = null;
    };
  }

  // ---------------------------------------------------------------- sessions

  /** Starts (or restarts) the session of the tab's active pane. */
  async connect(tabId: string): Promise<void> {
    const paneId = this.activePaneOfTab(tabId);
    if (paneId) await this.connectPane(paneId);
  }

  /** Starts (or restarts) a pane's session: SSH for server panes, the login shell for local panes. */
  async connectPane(paneId: string): Promise<void> {
    const pane = this.paneState(paneId);
    const runtime = this.runtimes.get(paneId);
    if (!pane || !runtime || runtime.closing || runtime.sessionId || pane.status === "connecting" || pane.status === "connected") return;
    const server = pane.kind === "ssh" ? pane.server : null;
    if (pane.kind === "ssh" && !server) return;

    const sessionId = crypto.randomUUID();
    runtime.sessionId = sessionId;
    // Clipboard read permission only lasts for one session.
    runtime.clipboardReadAllowed = false;
    if (this.pendingClipboardRead?.paneId === paneId) this.pendingClipboardRead = null;
    runtime.terminal.reset();
    if (server) {
      const address = server.port && server.port !== 22 ? `${server.host}:${server.port}` : server.host;
      const target = server.label ? `${server.label} (${address})` : `${server.username ? `${server.username}@` : ""}${address}`;
      runtime.terminal.writeln(t("notice.connectingTo", { target }));
    }
    this.updatePane(paneId, { status: "connecting", notice: "" });
    this.applyAppearance(paneId);

    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = (bytes) => {
      if (this.runtimes.get(paneId) === runtime) runtime.terminal.write(new Uint8Array(bytes));
    };
    const onState = new Channel<SessionEvent>();
    onState.onmessage = (event) => {
      if (this.runtimes.get(paneId) !== runtime) return;
      if (runtime.closing && event.state === "connected") return;
      const status: SessionStatus = event.state;
      if (event.state === "disconnected" || event.state === "failed") {
        runtime.sessionId = null;
      }
      this.updatePane(paneId, {
        status,
        notice: "message" in event ? translateBackend(event.message) : "",
      });
      if (event.state === "connected") {
        requestAnimationFrame(() => requestAnimationFrame(() => this.fitPane(paneId)));
      }
    };

    const terminal = runtime.terminal;
    const size = {
      cols: terminal.cols >= 10 ? terminal.cols : 100,
      rows: terminal.rows >= 2 ? terminal.rows : 30,
    };
    const start = server
      ? invoke<void>("connect_host", {
        request: {
          sessionId,
          host: server.host,
          port: server.port,
          username: server.username || null,
          identityFile: server.identityFile || null,
          ...size,
        },
        onData,
        onState,
      })
      : invoke<void>("open_local_shell", { request: { sessionId, ...size }, onData, onState });
    const connectPromise = start.catch((error: unknown) => {
      if (runtime.sessionId === sessionId) runtime.sessionId = null;
      if (!runtime.closing && this.runtimes.get(paneId) === runtime) {
        this.updatePane(paneId, { status: "failed", notice: translateBackend(error) });
        runtime.terminal.writeln(`\r\n[Crabshell] ${translateBackend(error)}`);
      }
    });
    runtime.connectPromise = connectPromise;
    try {
      await connectPromise;
    } finally {
      if (runtime.connectPromise === connectPromise) runtime.connectPromise = null;
    }
  }

  /** Ends the session of the tab's active pane. */
  async disconnect(tabId: string): Promise<void> {
    const paneId = this.activePaneOfTab(tabId);
    if (paneId) await this.disconnectPane(paneId);
  }

  async disconnectPane(paneId: string): Promise<void> {
    const runtime = this.runtimes.get(paneId);
    if (!runtime || !runtime.sessionId || runtime.closing) return;
    this.updatePane(paneId, { status: "disconnecting", notice: "" });
    if (runtime.connectPromise) await runtime.connectPromise;
    const sessionId = runtime.sessionId;
    if (!sessionId || this.runtimes.get(paneId) !== runtime) return;
    try {
      await invoke("close_session", { sessionId });
      if (runtime.sessionId === sessionId) runtime.sessionId = null;
      const pane = this.paneState(paneId);
      this.updatePane(paneId, { status: "disconnected", notice: pane?.kind === "local" ? t("notice.shellExited") : t("notice.disconnected") });
    } catch (error) {
      this.updatePane(paneId, { status: "failed", notice: translateBackend(error) });
    }
  }

  /** Ends the pane's session and frees its terminal; the pane stays in the tab list until the caller removes it. */
  private async shutdownPane(paneId: string): Promise<boolean> {
    const runtime = this.runtimes.get(paneId);
    if (!runtime || runtime.closing) return false;
    runtime.closing = true;
    this.updatePane(paneId, { status: "disconnecting", notice: "" });
    if (runtime.connectPromise) await runtime.connectPromise;
    if (this.runtimes.get(paneId) !== runtime) return false;

    const sessionId = runtime.sessionId;
    if (sessionId) {
      runtime.sessionId = null;
      try {
        await invoke("close_session", { sessionId });
      } catch {
        runtime.terminal.writeln(`\r\n[Crabshell] ${t("notice.closeFailed")}`);
      }
    }

    runtime.observer?.disconnect();
    if (runtime.selectionTimer !== null) window.clearTimeout(runtime.selectionTimer);
    runtime.terminal.dispose();
    this.runtimes.delete(paneId);
    if (this.pendingPaste?.paneId === paneId) this.pendingPaste = null;
    if (this.contextMenu?.paneId === paneId) this.contextMenu = null;
    if (this.pendingClipboardRead?.paneId === paneId) this.pendingClipboardRead = null;
    return true;
  }

  /** Closes one pane; closing the last pane closes the whole tab. */
  async closePane(paneId: string): Promise<void> {
    const tab = this.tabOf(paneId);
    if (!tab) return;
    if (tab.panes.length <= 1) {
      await this.closeTab(tab.id);
      return;
    }
    if (!(await this.shutdownPane(paneId))) return;
    this.tabs = this.tabs.map((item) => {
      if (item.id !== tab.id) return item;
      const panes = item.panes.filter((pane) => pane.id !== paneId);
      return withActivePane({ ...item, panes, split: panes.length > 1 ? item.split : null, activePaneId: item.activePaneId === paneId ? panes[0].id : item.activePaneId });
    });
    this.publish();
    const remaining = this.tabs.find((item) => item.id === tab.id);
    if (remaining && this.activeTabId === remaining.id) this.refitTab(remaining.id, remaining.activePaneId);
  }

  /** Closes the focused pane of the active tab (or the tab when it is not split). */
  closeActivePane(): void {
    const paneId = this.activePaneId();
    if (paneId) void this.closePane(paneId);
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    const results = await Promise.all(tab.panes.map((pane) => this.shutdownPane(pane.id)));
    if (!results.some(Boolean)) return;
    this.tabs = this.tabs.filter((item) => item.id !== tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs.at(-1)?.id ?? null;
    }
    this.publish();
    if (this.activeTabId) this.activateTab(this.activeTabId);
  }

  private fitPane(paneId: string): void {
    const runtime = this.runtimes.get(paneId);
    if (!runtime?.element || this.activeTabId !== runtime.tabId) return;
    try {
      runtime.fitAddon.fit();
      if (runtime.startOnFit && runtime.terminal.cols >= 10 && runtime.terminal.rows >= 2) {
        // The session starts with this size; no resize until the backend has opened it.
        runtime.startOnFit = false;
        void this.connectPane(paneId);
        return;
      }
      if (runtime.sessionId && runtime.terminal.cols >= 10 && runtime.terminal.rows >= 2) {
        void invoke("resize_session", {
          sessionId: runtime.sessionId,
          cols: runtime.terminal.cols,
          rows: runtime.terminal.rows,
        }).catch((error: unknown) => this.updatePane(paneId, { notice: translateBackend(error) }));
      }
    } catch {
      return;
    }
  }

  /** Applies the user's shortcut settings (missing actions use the defaults). */
  setKeybindings(custom: Keybindings | undefined): void {
    this.bindings = resolveKeybindings(custom);
    this.keyMap = new Map();
    for (const { action } of KEY_ACTIONS) {
      for (const combo of this.bindings[action]) if (!this.keyMap.has(combo)) this.keyMap.set(combo, action);
    }
  }

  /** Display label of an action's first shortcut, e.g. "Ctrl+Shift+E", or "" when unbound. */
  shortcutLabel(action: KeyAction): string {
    return primaryCombo(this.bindings, action);
  }

  private handleTerminalKey(event: KeyboardEvent, paneId: string): boolean {
    if (event.type !== "keydown") return true;
    const combo = comboFromEvent(event);
    const action = combo ? this.keyMap.get(combo) : undefined;
    if (!action || !this.runAction(action, paneId)) return true;
    // preventDefault also suppresses the native paste event, so text is not inserted twice.
    event.preventDefault();
    return false;
  }

  /**
   * Shortcuts while the focus is outside a terminal (e.g. on the welcome guide or a button).
   * Copy and paste are left to the WebView there. Returns true when the key was handled.
   */
  handleGlobalKey(event: KeyboardEvent): boolean {
    const combo = comboFromEvent(event);
    const action = combo ? this.keyMap.get(combo) : undefined;
    if (!action || action === "copy" || action === "paste") return false;
    if (!this.runAction(action, this.activePaneId())) return false;
    event.preventDefault();
    return true;
  }

  /** Runs a shortcut action for a pane (or for the app when no pane is open). False when it did nothing. */
  private runAction(action: KeyAction, paneId: string | null): boolean {
    switch (action) {
      case "copy":
        if (!paneId) return false;
        void this.copySelection(paneId);
        return true;
      case "paste":
        if (!paneId) return false;
        void this.pasteFromClipboard(paneId);
        return true;
      case "snippets":
        this.snippetShortcutHandler?.();
        return true;
      case "toggleSidebar":
        this.sidebarShortcutHandler?.();
        return true;
      case "newTab":
        this.newTabShortcutHandler?.();
        return true;
      case "localShell":
        this.openLocalShell();
        return true;
      case "close":
        if (!paneId) return false;
        void this.closePane(paneId);
        return true;
      case "splitRight":
      case "splitDown":
        if (!paneId) return false;
        this.focusPane(paneId);
        this.splitActiveTab(action === "splitRight" ? "row" : "column", { kind: "same" });
        return true;
      case "otherPane": {
        const other = paneId ? this.tabOf(paneId)?.panes.find((pane) => pane.id !== paneId) : undefined;
        // Not split: let the program have the keys.
        if (!other) return false;
        this.focusPane(other.id, true);
        return true;
      }
      case "zoomIn":
      case "zoomOut":
      case "zoomReset": {
        const tabId = paneId ? this.runtimes.get(paneId)?.tabId : this.activeTabId;
        if (!tabId) return false;
        this.zoomTab(tabId, action === "zoomIn" ? 1 : action === "zoomOut" ? -1 : 0);
        return true;
      }
      case "nextTab":
      case "previousTab": {
        const activeTabId = this.activeTabId;
        if (this.tabs.length > 1 && activeTabId) {
          const index = this.tabs.findIndex((tab) => tab.id === activeTabId);
          const step = action === "previousTab" ? -1 : 1;
          this.activateTab(this.tabs[(index + step + this.tabs.length) % this.tabs.length].id);
        }
        return true;
      }
    }
  }

  private updatePane(paneId: string, patch: Partial<TerminalPaneState>): void {
    this.tabs = this.tabs.map((tab) => tab.panes.some((pane) => pane.id === paneId)
      ? withActivePane({ ...tab, panes: tab.panes.map((pane) => pane.id === paneId ? { ...pane, ...patch } : pane) })
      : tab);
    this.publish();
  }

  private publish(): void {
    this.snapshot = {
      tabs: this.tabs,
      activeTabId: this.activeTabId,
      pendingPaste: this.pendingPaste,
      contextMenu: this.contextMenu,
      pendingClipboardRead: this.pendingClipboardRead ? { tabId: this.pendingClipboardRead.tabId, paneId: this.pendingClipboardRead.paneId } : null,
    };
    for (const listener of this.listeners) listener();
  }

  private serverTitle(server: SavedHost): string {
    return server.label || (server.username ? `${server.username}@${server.host}` : server.host);
  }
}

export const terminalStore = new TerminalStore();

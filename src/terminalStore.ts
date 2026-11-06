import { Channel, invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { builtinAppearance, resolveAppearance, terminalTheme } from "./appearance";
import { t, translateBackend } from "./i18n";
import type { Appearance, SavedHost, SessionEvent, SessionStatus, TabKind, TerminalSnapshot, TerminalTab } from "./terminalTypes";

const initialSnapshot: TerminalSnapshot = { tabs: [], activeTabId: null, pendingPaste: null };

type ClipboardPreferences = {
  copyOnSelect: boolean;
  confirmMultilinePaste: boolean;
};

type TerminalRuntime = {
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLElement | null;
  observer: ResizeObserver | null;
  opened: boolean;
  sessionId: string | null;
  connectPromise: Promise<void> | null;
  closing: boolean;
  selectionTimer: number | null;
};

class TerminalStore {
  private tabs: TerminalTab[] = [];
  private activeTabId: string | null = null;
  private runtimes = new Map<string, TerminalRuntime>();
  private listeners = new Set<() => void>();
  private snapshot = initialSnapshot;
  private clipboardPreferences: ClipboardPreferences = {
    copyOnSelect: false,
    confirmMultilinePaste: true,
  };
  private pendingPaste: { tabId: string; text: string } | null = null;
  private appearances: Appearance[] = [builtinAppearance];
  private defaultAppearanceId = builtinAppearance.id;
  private localAppearanceId = "";

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TerminalSnapshot => this.snapshot;

  setClipboardPreferences(preferences: ClipboardPreferences): void {
    this.clipboardPreferences = preferences;
  }

  setAppearances(appearances: Appearance[], defaultAppearanceId: string, localAppearanceId: string): void {
    this.appearances = appearances;
    this.defaultAppearanceId = defaultAppearanceId;
    this.localAppearanceId = localAppearanceId;
    for (const tab of this.tabs) this.applyAppearance(tab.id);
  }

  /** Keeps open tabs in sync after server profiles were edited or removed. */
  updateServers(servers: SavedHost[]): void {
    for (const tab of this.tabs) {
      if (!tab.server) continue;
      const updated = servers.find((server) => server.id === tab.server?.id);
      if (!updated) continue;
      this.updateTab(tab.id, { server: updated, title: this.serverTitle(updated) });
      this.applyAppearance(tab.id);
    }
  }

  private applyAppearance(tabId: string): void {
    const tab = this.tabs.find((item) => item.id === tabId);
    const runtime = this.runtimes.get(tabId);
    if (!tab || !runtime) return;
    const appearance = this.appearanceFor(tab.kind, tab.server);
    runtime.terminal.options.theme = terminalTheme(appearance);
    if (runtime.terminal.options.fontSize !== appearance.fontSize) {
      runtime.terminal.options.fontSize = appearance.fontSize;
      // A new font size changes the cell grid, so the PTY needs the new dimensions.
      requestAnimationFrame(() => this.fitActiveTab(tabId));
    }
    if (tab.appearance !== appearance) this.updateTab(tabId, { appearance });
  }

  async copySelection(tabId: string): Promise<void> {
    const runtime = this.runtimes.get(tabId);
    const selection = runtime?.terminal.getSelection();
    if (!runtime || !selection) return;
    try {
      await writeText(selection);
      this.updateTab(tabId, { notice: t("notice.copied") });
    } catch (error) {
      this.updateTab(tabId, { notice: t("notice.copyFailed", { error: translateBackend(error) }) });
    }
  }

  async pasteFromClipboard(tabId: string): Promise<void> {
    const runtime = this.runtimes.get(tabId);
    if (!runtime || runtime.closing) return;
    try {
      const text = await readText();
      if (text) this.pasteText(tabId, text);
    } catch (error) {
      this.updateTab(tabId, { notice: t("notice.pasteFailed", { error: translateBackend(error) }) });
    }
  }

  /** Routes every paste (shortcut, context menu, middle click) through the multiline check. */
  private pasteText(tabId: string, text: string): void {
    const runtime = this.runtimes.get(tabId);
    if (!runtime || runtime.closing || !text) return;
    if (!this.canSendInput(tabId)) {
      this.updateTab(tabId, { notice: t("notice.pasteNoSession") });
      return;
    }
    if (this.clipboardPreferences.confirmMultilinePaste && /[\r\n]/.test(text)) {
      this.pendingPaste = { tabId, text };
      this.publish();
      return;
    }
    runtime.terminal.paste(text);
  }

  confirmPendingPaste(): void {
    const pending = this.pendingPaste;
    if (!pending) return;
    const runtime = this.runtimes.get(pending.tabId);
    if (runtime && !runtime.closing) runtime.terminal.paste(pending.text);
    this.pendingPaste = null;
    this.publish();
    runtime?.terminal.focus();
  }

  cancelPendingPaste(): void {
    const pending = this.pendingPaste;
    if (!pending) return;
    this.pendingPaste = null;
    this.publish();
    this.runtimes.get(pending.tabId)?.terminal.focus();
  }

  private canSendInput(tabId: string): boolean {
    const runtime = this.runtimes.get(tabId);
    const tab = this.tabs.find((item) => item.id === tabId);
    return Boolean(runtime && !runtime.closing && runtime.sessionId && tab?.status === "connected");
  }

  private appearanceFor(kind: TabKind, server: SavedHost | null): Appearance {
    const preferredId = kind === "local" ? this.localAppearanceId : server?.appearanceId ?? "";
    return resolveAppearance(preferredId, this.appearances, this.defaultAppearanceId);
  }

  /** Opens a new tab running the user's local login shell. */
  openLocalShell(): string {
    const tabId = this.createTab(null);
    void this.connect(tabId);
    return tabId;
  }

  /** Opens a new tab and connects it to the given server over SSH. */
  openServer(server: SavedHost): string {
    const tabId = this.createTab(server);
    void this.connect(tabId);
    return tabId;
  }

  /** `server === null` creates a local shell tab. */
  private createTab(server: SavedHost | null): string {
    const id = crypto.randomUUID();
    const paneId = crypto.randomUUID();
    const kind: TabKind = server ? "ssh" : "local";
    const appearance = this.appearanceFor(kind, server);
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"JetBrains Mono", "DejaVu Sans Mono", monospace',
      fontSize: appearance.fontSize,
      lineHeight: 1.35,
      scrollback: 4000,
      theme: terminalTheme(appearance),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    try {
      terminal.loadAddon(new WebglAddon());
    } catch {
      // The DOM renderer remains available when WebGL is unavailable.
    }

    const runtime: TerminalRuntime = {
      terminal,
      fitAddon,
      element: null,
      observer: null,
      opened: false,
      sessionId: null,
      connectPromise: null,
      closing: false,
      selectionTimer: null,
    };
    this.runtimes.set(id, runtime);
    terminal.attachCustomKeyEventHandler((event) => this.handleTerminalKey(event));
    terminal.onSelectionChange(() => {
      if (!this.clipboardPreferences.copyOnSelect) return;
      if (runtime.selectionTimer !== null) window.clearTimeout(runtime.selectionTimer);
      // Debounce so dragging a selection writes the clipboard once, not on every mouse move.
      runtime.selectionTimer = window.setTimeout(() => {
        runtime.selectionTimer = null;
        const selection = terminal.getSelection();
        if (selection && this.runtimes.get(id) === runtime) {
          void writeText(selection).catch((error: unknown) => {
            this.updateTab(id, { notice: t("notice.copyFailed", { error: translateBackend(error) }) });
          });
        }
      }, 150);
    });
    terminal.onData((data) => {
      if (this.runtimes.get(id) !== runtime || !this.canSendInput(id) || !runtime.sessionId) return;
      const bytes = new TextEncoder().encode(data);
      void invoke("write_to_session", bytes, {
        headers: { "x-session-id": runtime.sessionId },
      }).catch((error: unknown) => this.updateTab(id, { notice: translateBackend(error) }));
    });

    this.tabs = [
      ...this.tabs,
      {
        id,
        kind,
        // Local tabs get their (translated) title at render time.
        title: server ? this.serverTitle(server) : "",
        server,
        paneTree: { kind: "pane", paneId },
        status: "disconnected",
        notice: "",
        appearance,
      },
    ];
    this.activateTab(id);
    return id;
  }

  activateTab(tabId: string): void {
    if (!this.tabs.some((tab) => tab.id === tabId)) return;
    this.activeTabId = tabId;
    this.publish();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.fitActiveTab(tabId));
      this.runtimes.get(tabId)?.terminal.focus();
    });
  }

  getTerminal(tabId: string, paneId: string): Terminal | null {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab || tab.paneTree.paneId !== paneId) return null;
    return this.runtimes.get(tabId)?.terminal ?? null;
  }

  attachPane(tabId: string, paneId: string, element: HTMLElement): () => void {
    const terminal = this.getTerminal(tabId, paneId);
    const runtime = this.runtimes.get(tabId);
    if (!terminal || !runtime) return () => undefined;

    runtime.element = element;
    if (!runtime.opened) {
      terminal.open(element);
      runtime.opened = true;
    }

    runtime.observer?.disconnect();
    runtime.observer = new ResizeObserver(() => this.fitActiveTab(tabId));
    runtime.observer.observe(element);
    if (this.activeTabId === tabId) {
      requestAnimationFrame(() => requestAnimationFrame(() => this.fitActiveTab(tabId)));
    }

    // Capture native paste events (context menu, middle click) before xterm's own
    // textarea handler sends them unchecked, so they share the multiline confirmation.
    const onNativePaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text) this.pasteText(tabId, text);
    };
    element.addEventListener("paste", onNativePaste, true);

    return () => {
      element.removeEventListener("paste", onNativePaste, true);
      if (runtime.element !== element) return;
      runtime.observer?.disconnect();
      runtime.observer = null;
      runtime.element = null;
    };
  }

  /** Starts (or restarts) the tab's session: SSH for server tabs, the login shell for local tabs. */
  async connect(tabId: string): Promise<void> {
    const tab = this.tabs.find((item) => item.id === tabId);
    const runtime = this.runtimes.get(tabId);
    if (!tab || !runtime || runtime.closing || runtime.sessionId || tab.status === "connecting" || tab.status === "connected") return;
    const server = tab.kind === "ssh" ? tab.server : null;
    if (tab.kind === "ssh" && !server) return;

    const sessionId = crypto.randomUUID();
    runtime.sessionId = sessionId;
    runtime.terminal.reset();
    if (server) {
      const target = server.label ? `${server.label} (${server.host})` : `${server.username ? `${server.username}@` : ""}${server.host}`;
      runtime.terminal.writeln(t("notice.connectingTo", { target }));
    }
    this.updateTab(tabId, { status: "connecting", notice: "" });
    this.applyAppearance(tabId);

    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = (bytes) => {
      if (this.runtimes.get(tabId) === runtime) runtime.terminal.write(new Uint8Array(bytes));
    };
    const onState = new Channel<SessionEvent>();
    onState.onmessage = (event) => {
      if (this.runtimes.get(tabId) !== runtime) return;
      if (runtime.closing && event.state === "connected") return;
      const status: SessionStatus = event.state;
      if (event.state === "disconnected" || event.state === "failed") {
        runtime.sessionId = null;
      }
      this.updateTab(tabId, {
        status,
        notice: "message" in event ? translateBackend(event.message) : "",
      });
      if (event.state === "connected") {
        requestAnimationFrame(() => requestAnimationFrame(() => this.fitActiveTab(tabId)));
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
      if (!runtime.closing && this.runtimes.get(tabId) === runtime) {
        this.updateTab(tabId, { status: "failed", notice: translateBackend(error) });
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

  async disconnect(tabId: string): Promise<void> {
    const runtime = this.runtimes.get(tabId);
    if (!runtime || !runtime.sessionId || runtime.closing) return;
    this.updateTab(tabId, { status: "disconnecting", notice: "" });
    if (runtime.connectPromise) await runtime.connectPromise;
    const sessionId = runtime.sessionId;
    if (!sessionId || this.runtimes.get(tabId) !== runtime) return;
    try {
      await invoke("close_session", { sessionId });
      if (runtime.sessionId === sessionId) runtime.sessionId = null;
      const tab = this.tabs.find((item) => item.id === tabId);
      this.updateTab(tabId, { status: "disconnected", notice: tab?.kind === "local" ? t("notice.shellExited") : t("notice.disconnected") });
    } catch (error) {
      this.updateTab(tabId, { status: "failed", notice: translateBackend(error) });
    }
  }

  async closeTab(tabId: string): Promise<void> {
    const runtime = this.runtimes.get(tabId);
    if (!runtime || runtime.closing) return;
    runtime.closing = true;
    this.updateTab(tabId, { status: "disconnecting", notice: "" });
    if (runtime.connectPromise) await runtime.connectPromise;
    if (this.runtimes.get(tabId) !== runtime) return;

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
    this.runtimes.delete(tabId);
    if (this.pendingPaste?.tabId === tabId) this.pendingPaste = null;
    this.tabs = this.tabs.filter((tab) => tab.id !== tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs.at(-1)?.id ?? null;
    }
    this.publish();
    if (this.activeTabId) this.activateTab(this.activeTabId);
  }

  private fitActiveTab(tabId: string): void {
    if (this.activeTabId !== tabId) return;
    const runtime = this.runtimes.get(tabId);
    if (!runtime?.element) return;
    try {
      runtime.fitAddon.fit();
      if (runtime.sessionId && runtime.terminal.cols >= 10 && runtime.terminal.rows >= 2) {
        void invoke("resize_session", {
          sessionId: runtime.sessionId,
          cols: runtime.terminal.cols,
          rows: runtime.terminal.rows,
        }).catch((error: unknown) => this.updateTab(tabId, { notice: translateBackend(error) }));
      }
    } catch {
      return;
    }
  }

  private handleTerminalKey(event: KeyboardEvent): boolean {
    if (event.type !== "keydown" || !event.ctrlKey) return true;
    const key = event.key.toLowerCase();
    const activeTabId = this.activeTabId;
    if (event.shiftKey && key === "c") {
      event.preventDefault();
      if (activeTabId) void this.copySelection(activeTabId);
      return false;
    }
    if (event.shiftKey && key === "v") {
      // preventDefault also suppresses the native paste event, so text is not inserted twice.
      event.preventDefault();
      if (activeTabId) void this.pasteFromClipboard(activeTabId);
      return false;
    }
    if (event.shiftKey && key === "t") {
      event.preventDefault();
      this.openLocalShell();
      return false;
    }
    if (event.shiftKey && key === "w") {
      event.preventDefault();
      if (activeTabId) void this.closeTab(activeTabId);
      return false;
    }
    if (key === "tab") {
      event.preventDefault();
      if (this.tabs.length > 1 && activeTabId) {
        const index = this.tabs.findIndex((tab) => tab.id === activeTabId);
        const direction = event.shiftKey ? -1 : 1;
        const nextIndex = (index + direction + this.tabs.length) % this.tabs.length;
        this.activateTab(this.tabs[nextIndex].id);
      }
      return false;
    }
    return true;
  }

  private updateTab(tabId: string, patch: Partial<TerminalTab>): void {
    this.tabs = this.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab));
    this.publish();
  }

  private publish(): void {
    this.snapshot = {
      tabs: this.tabs,
      activeTabId: this.activeTabId,
      pendingPaste: this.pendingPaste,
    };
    for (const listener of this.listeners) listener();
  }

  private serverTitle(server: SavedHost): string {
    return server.label || (server.username ? `${server.username}@${server.host}` : server.host);
  }
}

export const terminalStore = new TerminalStore();

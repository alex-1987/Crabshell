import { Channel, invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { SavedHost, SessionEvent, SessionStatus, TerminalSnapshot, TerminalTab } from "./terminalTypes";

const initialSnapshot: TerminalSnapshot = { tabs: [], activeTabId: null, pendingPaste: null };

type ClipboardPreferences = {
  copyOnSelect: boolean;
  confirmMultilinePaste: boolean;
};

const terminalTheme = {
  background: "#10120f",
  foreground: "#d8ded2",
  cursor: "#c7e77a",
  cursorAccent: "#10120f",
  selectionBackground: "#65734b88",
  black: "#20241e",
  red: "#ed7a62",
  green: "#b3d875",
  yellow: "#e4c47a",
  blue: "#8eabb7",
  magenta: "#b7a0bd",
  cyan: "#87c6b0",
  white: "#d8ded2",
  brightBlack: "#747d6d",
  brightRed: "#f18e78",
  brightGreen: "#c7e77a",
  brightYellow: "#efd28d",
  brightBlue: "#a4c4d2",
  brightMagenta: "#c7b1cd",
  brightCyan: "#9ad6c2",
  brightWhite: "#f1f3eb",
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

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TerminalSnapshot => this.snapshot;

  setClipboardPreferences(preferences: ClipboardPreferences): void {
    this.clipboardPreferences = preferences;
  }

  async copySelection(tabId: string): Promise<void> {
    const runtime = this.runtimes.get(tabId);
    const selection = runtime?.terminal.getSelection();
    if (!runtime || !selection) return;
    try {
      await writeText(selection);
      this.updateTab(tabId, { notice: "Auswahl in die Zwischenablage kopiert." });
    } catch (error) {
      this.updateTab(tabId, { notice: `Kopieren fehlgeschlagen: ${String(error)}` });
    }
  }

  async pasteFromClipboard(tabId: string): Promise<void> {
    const runtime = this.runtimes.get(tabId);
    if (!runtime || runtime.closing) return;
    try {
      const text = await readText();
      if (!text) return;
      if (this.clipboardPreferences.confirmMultilinePaste && /[\r\n]/.test(text)) {
        this.pendingPaste = { tabId, text };
        this.publish();
        return;
      }
      runtime.terminal.paste(text);
    } catch (error) {
      this.updateTab(tabId, { notice: `Einfügen fehlgeschlagen: ${String(error)}` });
    }
  }

  confirmPendingPaste(): void {
    const pending = this.pendingPaste;
    if (!pending) return;
    const runtime = this.runtimes.get(pending.tabId);
    if (runtime && !runtime.closing) runtime.terminal.paste(pending.text);
    this.pendingPaste = null;
    this.publish();
  }

  cancelPendingPaste(): void {
    if (!this.pendingPaste) return;
    this.pendingPaste = null;
    this.publish();
  }

  createTab(server: SavedHost | null = null): string {
    const id = crypto.randomUUID();
    const paneId = crypto.randomUUID();
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"JetBrains Mono", "DejaVu Sans Mono", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 4000,
      theme: terminalTheme,
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
    };
    this.runtimes.set(id, runtime);
    terminal.attachCustomKeyEventHandler((event) => this.handleTerminalKey(event));
    terminal.onData((data) => {
      const currentTab = this.tabs.find((tab) => tab.id === id);
      if (this.runtimes.get(id) !== runtime || runtime.closing || !runtime.sessionId || currentTab?.status !== "connected") return;
      const bytes = new TextEncoder().encode(data);
      void invoke("write_to_session", bytes, {
        headers: { "x-session-id": runtime.sessionId },
      }).catch((error: unknown) => this.updateTab(id, { notice: String(error) }));
    });

    this.tabs = [
      ...this.tabs,
      {
        id,
        title: server ? this.serverTitle(server) : "Neuer Tab",
        server,
        paneTree: { kind: "pane", paneId },
        status: "disconnected",
        notice: "",
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
      terminal.writeln("Crabshell // lokales SSH-Terminal");
      terminal.writeln("OpenSSH übernimmt Schlüssel, Agent und known_hosts.");
      terminal.writeln("");
    }

    runtime.observer?.disconnect();
    runtime.observer = new ResizeObserver(() => this.fitActiveTab(tabId));
    runtime.observer.observe(element);
    if (this.activeTabId === tabId) {
      requestAnimationFrame(() => requestAnimationFrame(() => this.fitActiveTab(tabId)));
    }

    return () => {
      if (runtime.element !== element) return;
      runtime.observer?.disconnect();
      runtime.observer = null;
      runtime.element = null;
    };
  }

  async connect(tabId: string, server?: SavedHost): Promise<void> {
    const tab = this.tabs.find((item) => item.id === tabId);
    const runtime = this.runtimes.get(tabId);
    if (!tab || !runtime || runtime.closing || runtime.sessionId || tab.status === "connecting" || tab.status === "connected") return;

    const selectedServer = server ?? tab.server;
    if (!selectedServer) {
      this.updateTab(tabId, { notice: "Wähle zuerst einen gespeicherten Server aus der Seitenleiste." });
      return;
    }

    const sessionId = crypto.randomUUID();
    runtime.sessionId = sessionId;
    const title = this.serverTitle(selectedServer);
    runtime.terminal.clear();
    runtime.terminal.writeln(`Verbinde mit ${selectedServer.label ? `${selectedServer.label} (${selectedServer.host})` : `${selectedServer.username ? `${selectedServer.username}@` : ""}${selectedServer.host}`} ...`);
    this.updateTab(tabId, {
      title,
      server: selectedServer,
      status: "connecting",
      notice: "",
    });

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
        notice: "message" in event ? event.message : "",
      });
      if (event.state === "connected") {
        requestAnimationFrame(() => requestAnimationFrame(() => this.fitActiveTab(tabId)));
      }
    };

    const terminal = runtime.terminal;
    const connectPromise = invoke<void>("connect_host", {
        request: {
          sessionId,
          host: selectedServer.host,
          username: selectedServer.username || null,
          identityFile: selectedServer.identityFile || null,
          cols: terminal.cols >= 20 ? terminal.cols : 100,
          rows: terminal.rows >= 5 ? terminal.rows : 30,
        },
        onData,
        onState,
      }).catch((error: unknown) => {
      if (runtime.sessionId === sessionId) runtime.sessionId = null;
      if (!runtime.closing && this.runtimes.get(tabId) === runtime) {
        this.updateTab(tabId, { status: "failed", notice: String(error) });
        runtime.terminal.writeln(`\r\n[Crabshell] ${String(error)}`);
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
      this.updateTab(tabId, { status: "disconnected", notice: "Verbindung getrennt." });
    } catch (error) {
      this.updateTab(tabId, { status: "failed", notice: String(error) });
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
        runtime.terminal.writeln("\r\n[Crabshell] The session could not be closed cleanly.");
      }
    }

    runtime.observer?.disconnect();
    runtime.terminal.dispose();
    this.runtimes.delete(tabId);
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
      if (runtime.sessionId && runtime.terminal.cols >= 20 && runtime.terminal.rows >= 5) {
        void invoke("resize_session", {
          sessionId: runtime.sessionId,
          cols: runtime.terminal.cols,
          rows: runtime.terminal.rows,
        }).catch((error: unknown) => this.updateTab(tabId, { notice: String(error) }));
      }
    } catch {
      return;
    }
  }

  private handleTerminalKey(event: KeyboardEvent): boolean {
    if (event.type !== "keydown" || !event.ctrlKey) return true;
    const key = event.key.toLowerCase();
    const activeTabId = this.activeTabId;
    if (event.shiftKey && key === "t") {
      event.preventDefault();
      this.createTab();
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

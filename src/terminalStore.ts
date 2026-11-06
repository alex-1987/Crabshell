import { Channel, invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { builtinAppearance, resolveAppearance, terminalTheme } from "./appearance";
import { t, translateBackend } from "./i18n";
import type { Appearance, ClipboardReadMode, PendingClipboardRead, PendingPaste, SavedHost, SessionEvent, SessionStatus, TabKind, TerminalContextMenu, TerminalSnapshot, TerminalTab } from "./terminalTypes";

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

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Upper bound for OSC 52 payloads (base64), so a program cannot flood the clipboard. */
const MAX_OSC52_LENGTH = 1024 * 1024;

/**
 * Decodes an OSC 52 payload "<targets>;<base64>". Returns null for queries ("?"),
 * which are refused so programs can never read the clipboard, and for invalid data.
 */
export function decodeOsc52(data: string): string | null {
  const separator = data.indexOf(";");
  if (separator < 0) return null;
  const payload = data.slice(separator + 1);
  if (payload === "?" || payload.length > MAX_OSC52_LENGTH) return null;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

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
  /** The user allowed OSC 52 clipboard reads for the current session. */
  clipboardReadAllowed: boolean;
  /** Keeps terminal input in order, e.g. a pasted snippet before the Enter that runs it. */
  writeChain: Promise<void>;
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
    forceMouseSelection: false,
    allowClipboardWrite: true,
    clipboardRead: "ask",
  };
  private pendingPaste: PendingPaste | null = null;
  private snippetShortcutHandler: (() => void) | null = null;
  private contextMenu: TerminalContextMenu | null = null;
  private pendingClipboardRead: (PendingClipboardRead & { target: string }) | null = null;
  private appearances: Appearance[] = [builtinAppearance];
  private defaultAppearanceId = builtinAppearance.id;
  private localAppearanceId = "";

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TerminalSnapshot => this.snapshot;

  /** Called when Ctrl+Shift+S is pressed inside a terminal. */
  onSnippetShortcut(handler: (() => void) | null): void {
    this.snippetShortcutHandler = handler;
  }

  closeContextMenu(focus = true): void {
    const menu = this.contextMenu;
    if (!menu) return;
    this.contextMenu = null;
    this.publish();
    if (focus) this.runtimes.get(menu.tabId)?.terminal.focus();
  }

  runContextAction(action: "copy" | "paste" | "selectAll" | "snippets"): void {
    const menu = this.contextMenu;
    if (!menu) return;
    this.closeContextMenu(action !== "snippets");
    const runtime = this.runtimes.get(menu.tabId);
    if (!runtime) return;
    if (action === "copy") void this.copySelection(menu.tabId);
    else if (action === "paste") void this.pasteFromClipboard(menu.tabId);
    else if (action === "selectAll") runtime.terminal.selectAll();
    else this.snippetShortcutHandler?.();
  }

  /** Whether the active tab has a connected session that can receive input. */
  canSendToActiveTab(): boolean {
    return this.activeTabId !== null && this.canSendInput(this.activeTabId);
  }

  focusActiveTerminal(): void {
    if (this.activeTabId) this.runtimes.get(this.activeTabId)?.terminal.focus();
  }

  /**
   * Pastes a snippet into the active terminal (never sends it on its own). Trailing line
   * breaks are removed first; multiline snippets always need a confirmation.
   * With `execute`, Enter is sent afterwards. Returns false when no session is connected.
   */
  insertSnippet(text: string, execute: boolean): boolean {
    const tabId = this.activeTabId;
    const trimmed = text.replace(/[\r\n]+$/, "");
    if (!tabId || !this.canSendInput(tabId)) {
      if (tabId) this.updateTab(tabId, { notice: t("notice.snippetNoSession") });
      return false;
    }
    if (!trimmed) return true;
    if (/[\r\n]/.test(trimmed)) {
      this.pendingPaste = { tabId, text: trimmed, source: "snippet", execute };
      this.publish();
      return true;
    }
    this.pasteNow(tabId, trimmed, execute);
    return true;
  }

  private pasteNow(tabId: string, text: string, execute: boolean): void {
    const runtime = this.runtimes.get(tabId);
    if (!runtime || !this.canSendInput(tabId)) return;
    // paste() applies bracketed paste mode and emits onData synchronously,
    // so the Enter below is queued after the pasted text.
    runtime.terminal.paste(text);
    if (execute) this.sendInput(tabId, "\r");
    runtime.terminal.focus();
  }

  /** Sends input to the session the same way keystrokes are sent. */
  private sendInput(tabId: string, data: string): void {
    const runtime = this.runtimes.get(tabId);
    const sessionId = runtime?.sessionId;
    if (!runtime || !sessionId || !this.canSendInput(tabId)) return;
    const bytes = new TextEncoder().encode(data);
    for (let offset = 0; offset < bytes.length; offset += MAX_WRITE_BYTES) {
      const chunk = bytes.slice(offset, offset + MAX_WRITE_BYTES);
      runtime.writeChain = runtime.writeChain
        .then(() => invoke<void>("write_to_session", chunk, { headers: { "x-session-id": sessionId } }))
        .catch((error: unknown) => this.updateTab(tabId, { notice: translateBackend(error) }));
    }
  }

  /** OSC 52 query from a program: answer per the user's setting, or ask first. */
  private handleClipboardRead(tabId: string, target: string): void {
    const runtime = this.runtimes.get(tabId);
    if (!runtime || !this.canSendInput(tabId)) return;
    const mode = this.clipboardPreferences.clipboardRead;
    if (mode === "never") {
      this.replyClipboard(tabId, target, "");
    } else if (mode === "always" || runtime.clipboardReadAllowed) {
      void this.replyWithClipboard(tabId, target);
    } else if (!this.pendingClipboardRead) {
      this.pendingClipboardRead = { tabId, target };
      this.publish();
    }
  }

  /** "deny" answers with an empty clipboard; "session" allows reads until the session ends. */
  answerClipboardRead(decision: "deny" | "session"): void {
    const pending = this.pendingClipboardRead;
    if (!pending) return;
    this.pendingClipboardRead = null;
    this.publish();
    const runtime = this.runtimes.get(pending.tabId);
    if (!runtime) return;
    if (decision === "deny") {
      this.replyClipboard(pending.tabId, pending.target, "");
    } else {
      runtime.clipboardReadAllowed = true;
      // Programs that wait (e.g. Neovim) get the answer now. micro gives up after 200 ms and
      // drops late answers, so the user presses Ctrl+V again; that one is answered at once.
      void this.replyWithClipboard(pending.tabId, pending.target);
      this.updateTab(pending.tabId, { notice: t("notice.clipboardReadAllowed") });
    }
    runtime.terminal.focus();
  }

  private async replyWithClipboard(tabId: string, target: string): Promise<void> {
    try {
      this.replyClipboard(tabId, target, (await readText()) ?? "");
    } catch (error) {
      this.replyClipboard(tabId, target, "");
      this.updateTab(tabId, { notice: t("notice.pasteFailed", { error: translateBackend(error) }) });
    }
  }

  private replyClipboard(tabId: string, target: string, text: string): void {
    // Terminated with ST (ESC + backslash): tcell (micro) does not accept BEL here.
    this.sendInput(tabId, `\x1b]52;${target};${text ? utf8ToBase64(text) : ""}\x1b\\`);
  }

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
      this.pendingPaste = { tabId, text, source: "clipboard", execute: false };
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
    const runtime = this.runtimes.get(pending.tabId);
    if (!runtime || runtime.closing) return;
    if (this.canSendInput(pending.tabId)) {
      this.pasteNow(pending.tabId, pending.text, pending.execute);
    } else {
      this.updateTab(pending.tabId, { notice: t(pending.source === "snippet" ? "notice.snippetNoSession" : "notice.pasteNoSession") });
      runtime.terminal.focus();
    }
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
      clipboardReadAllowed: false,
      writeChain: Promise.resolve(),
    };
    this.runtimes.set(id, runtime);
    terminal.attachCustomKeyEventHandler((event) => this.handleTerminalKey(event));
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
          .then(() => this.updateTab(id, { notice: t("notice.programCopied") }))
          .catch((error: unknown) => this.updateTab(id, { notice: t("notice.copyFailed", { error: translateBackend(error) }) }));
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
            this.updateTab(id, { notice: t("notice.copyFailed", { error: translateBackend(error) }) });
          });
        }
      }, 150);
    });
    terminal.onData((data) => {
      if (this.runtimes.get(id) === runtime) this.sendInput(id, data);
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

    // Mouse handling runs in the capture phase, before xterm forwards events to programs
    // that enabled mouse tracking (micro, htop, mc, ...).
    const onMouseDown = (event: MouseEvent) => {
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
        x: event.clientX,
        y: event.clientY,
        hasSelection: terminal.hasSelection(),
        canPaste: this.canSendInput(tabId),
      };
      this.publish();
    };
    element.addEventListener("mousedown", onMouseDown, true);
    element.addEventListener("contextmenu", onContextMenu, true);

    return () => {
      element.removeEventListener("paste", onNativePaste, true);
      element.removeEventListener("mousedown", onMouseDown, true);
      element.removeEventListener("contextmenu", onContextMenu, true);
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
    // Clipboard read permission only lasts for one session.
    runtime.clipboardReadAllowed = false;
    if (this.pendingClipboardRead?.tabId === tabId) this.pendingClipboardRead = null;
    runtime.terminal.reset();
    if (server) {
      const address = server.port && server.port !== 22 ? `${server.host}:${server.port}` : server.host;
      const target = server.label ? `${server.label} (${address})` : `${server.username ? `${server.username}@` : ""}${address}`;
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
    if (this.contextMenu?.tabId === tabId) this.contextMenu = null;
    if (this.pendingClipboardRead?.tabId === tabId) this.pendingClipboardRead = null;
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
    if (event.shiftKey && key === "s") {
      event.preventDefault();
      this.snippetShortcutHandler?.();
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
      contextMenu: this.contextMenu,
      pendingClipboardRead: this.pendingClipboardRead ? { tabId: this.pendingClipboardRead.tabId } : null,
    };
    for (const listener of this.listeners) listener();
  }

  private serverTitle(server: SavedHost): string {
    return server.label || (server.username ? `${server.username}@${server.host}` : server.host);
  }
}

export const terminalStore = new TerminalStore();

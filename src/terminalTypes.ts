export type SavedHost = {
  id: string;
  label: string;
  host: string;
  /** SSH port; 22 is not passed to ssh, so ~/.ssh/config can still set one. */
  port: number;
  username: string;
  identityFile: string;
  /** Empty string means the default appearance. */
  appearanceId: string;
  /** Sidebar group; empty string means no category. */
  category: string;
  /** Connect through the proxy from the settings (only while it is switched on and filled in). */
  useProxy: boolean;
};

export type Appearance = {
  id: string;
  name: string;
  fontSize: number;
  foreground: string;
  background: string;
  cursor: string;
  selection: string;
  tabColor: string;
  /**
   * Color of the shell prompt: replaces ANSI green, which standard prompts (Debian, Ubuntu)
   * use for user@host. Empty keeps the automatic color.
   */
  promptColor: string;
  /** Tabs of this design show no color line; tabColor is kept for switching it back on. */
  hideTabColor?: boolean;
};

import type { LanguageSetting } from "./i18n";
import type { Keybindings } from "./keybindings";

export type ThemeMode = "system" | "light" | "dark";
export type ProxyType = "socks5" | "http";
export type RightPanel = "snippets" | "files";
export type ClipboardReadMode = "ask" | "always" | "never";
/** Clicks needed to open a server or paste a snippet from the side panels. */
export type ClickMode = "single" | "double";

/** One tab of the last run (session.json); servers are referenced by id only. */
type SessionTab = {
  kind: TabKind;
  serverId: string;
  /** Second pane of a split tab; empty direction means not split. */
  splitDirection?: SplitDirection | "";
  splitKind?: TabKind | "";
  splitServerId?: string;
  /** Name the user gave the tab; empty or missing means the automatic title. */
  title?: string;
  /** Tab color chosen by the user; empty or missing means the color of the design. */
  color?: string;
};
export type SessionState = { tabs: SessionTab[]; activeIndex: number };

export type AppSettings = {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  /** Snippet panel on the right side of the window. */
  snippetPanelOpen: boolean;
  snippetPanelWidth: number;
  serverOpenClick: ClickMode;
  snippetInsertClick: ClickMode;
  /** Reopen the tabs of the last run on start instead of an empty workspace. */
  restoreTabs: boolean;
  /** Ask before closing the window while terminal sessions are still running. */
  confirmClose: boolean;
  /** Look for a newer release on GitHub at start (one anonymous request); off by default. */
  checkUpdates: boolean;
  /** The user answered the update question in the welcome guide (or changed the setting). */
  updatesAsked: boolean;
  /** Custom terminal shortcuts per action; missing actions use the defaults. */
  keybindings: Keybindings;
  copyOnSelect: boolean;
  confirmMultilinePaste: boolean;
  /** Plain mouse drags select text even when a program (e.g. micro) uses the mouse. */
  forceMouseSelection: boolean;
  /** Programs may set the clipboard with OSC 52 (write only, never read). */
  allowClipboardWrite: boolean;
  /** OSC 52 clipboard reads by programs (e.g. Ctrl+V in micro over SSH). */
  clipboardRead: ClipboardReadMode;
  appearances: Appearance[];
  defaultAppearanceId: string;
  /** Appearance for local shell tabs; empty string means the default appearance. */
  localAppearanceId: string;
  themeMode: ThemeMode;
  language: LanguageSetting;
  /** UI zoom in percent (terminal font size is set per appearance). */
  uiScale: number;
  /** Font family for the interface; "" = built-in default. */
  uiFont: string;
  /** Font family for the terminals; "" = built-in default. */
  terminalFont: string;
  /** Order of the server categories (sidebar groups and chips); missing ones follow alphabetically. */
  categoryOrder: string[];
  /** Order of the snippet tags (lower case); missing ones follow alphabetically. */
  tagOrder: string[];
  /** Reconnect SSH sessions that lost their connection (after standby, network change …). */
  autoReconnect: boolean;
  /** Send SSH keepalives, so a connection that died silently (VPN cut) ends and can reconnect. */
  keepaliveEnabled: boolean;
  /** Seconds between keepalives (5–300); the connection ends after 3 unanswered ones. */
  keepaliveSeconds: number;
  /** Tab of the right-hand panel. */
  rightPanel: RightPanel;
  /** The file browser follows the folder of the active terminal. */
  filesFollowTerminal: boolean;
  /** Program for "Edit" in the file browser (path or command name); "" = system default. */
  editor: string;
  /** Proxy for servers that use it; off means every connection is direct. */
  proxyEnabled: boolean;
  proxyType: ProxyType;
  /** Empty until the user enters a proxy. */
  proxyHost: string;
  proxyPort: number;
};

export type SessionStatus = "disconnected" | "connecting" | "connected" | "disconnecting" | "failed";

export type SessionEvent =
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "disconnected"; message: string; exitCode?: number | null }
  | { state: "failed"; message: string };

export type TabKind = "ssh" | "local";

/** "row": panes side by side (left | right); "column": stacked (top / bottom). */
export type SplitDirection = "row" | "column";

/** What a new split pane runs: the same target as the active pane, a local shell or a saved server. */
export type SplitTarget = { kind: "same" } | { kind: "local" } | { kind: "server"; server: SavedHost };

/** One terminal inside a tab, with its own session. */
export type TerminalPaneState = {
  id: string;
  kind: TabKind;
  title: string;
  server: SavedHost | null;
  status: SessionStatus;
  notice: string;
  /** Time of the pending automatic reconnect (ms since epoch); 0 when none is pending. */
  reconnectAt: number;
  /** Number of that automatic attempt (1 = first). */
  reconnectAttempt: number;
  /** Folder the remote shell reported (OSC 7 or the prompt's title); "" when unknown. May start with "~". */
  cwd: string;
  appearance: Appearance;
};

export type TerminalTab = {
  id: string;
  /** One pane, or two when the tab is split. */
  panes: TerminalPaneState[];
  split: SplitDirection | null;
  /** Share of the first pane (0.15–0.85). */
  splitRatio: number;
  activePaneId: string;
  /** Name the user gave the tab (double-click); empty means the automatic title from the panes. */
  customTitle: string;
  /** Tab color chosen by the user ("#rrggbb"); empty means the tab color of the design. */
  customColor: string;
  /** Ctrl+Plus / Ctrl+Minus zoom of the tab in font pixels (0 = the design's size). */
  fontZoom: number;
  /** Typing goes to every pane of the split tab. Never saved; off once the tab has one pane. */
  broadcast: boolean;
  // Mirrored from the active pane, so tab-level UI (title, status, reconnect) keeps working.
  kind: TabKind;
  title: string;
  server: SavedHost | null;
  status: SessionStatus;
  notice: string;
  appearance: Appearance;
};

/** Text waiting for the multiline confirmation before it is pasted into a terminal. */
export type PendingPaste = {
  tabId: string;
  paneId: string;
  text: string;
  source: "clipboard" | "snippet";
  /** Send Enter after pasting (snippet "insert and run"). */
  execute: boolean;
};

/** Crabshell's own terminal context menu (replaces the WebView menu). */
export type TerminalContextMenu = {
  tabId: string;
  paneId: string;
  /** The tab has two panes (offers "close pane" and broadcast). */
  split: boolean;
  /** The tab currently types into all panes. */
  broadcast: boolean;
  /** SSH pane: offers "Open folder in the file browser". */
  ssh: boolean;
  /** Folder the shell reported; "" when unknown. */
  cwd: string;
  x: number;
  y: number;
  hasSelection: boolean;
  canPaste: boolean;
};

/** A program asked to read the clipboard (OSC 52) and waits for the user's decision. */
export type PendingClipboardRead = {
  tabId: string;
  paneId: string;
};

export type TerminalSnapshot = {
  tabs: TerminalTab[];
  activeTabId: string | null;
  pendingPaste: PendingPaste | null;
  contextMenu: TerminalContextMenu | null;
  pendingClipboardRead: PendingClipboardRead | null;
};

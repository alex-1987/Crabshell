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
};

import type { LanguageSetting } from "./i18n";
import type { Keybindings } from "./keybindings";

export type ThemeMode = "system" | "light" | "dark";
export type ClipboardReadMode = "ask" | "always" | "never";
/** Clicks needed to open a server or paste a snippet from the side panels. */
export type ClickMode = "single" | "double";

/** One tab of the last run (session.json); servers are referenced by id only. */
export type SessionTab = {
  kind: TabKind;
  serverId: string;
  /** Second pane of a split tab; empty direction means not split. */
  splitDirection?: SplitDirection | "";
  splitKind?: TabKind | "";
  splitServerId?: string;
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
};

export type SessionStatus = "disconnected" | "connecting" | "connected" | "disconnecting" | "failed";

export type SessionEvent =
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "disconnected"; message: string }
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
  /** The tab has two panes (offers "close pane"). */
  split: boolean;
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

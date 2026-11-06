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

export type ThemeMode = "system" | "light" | "dark";
export type ClipboardReadMode = "ask" | "always" | "never";

export type AppSettings = {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
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

export type PaneNode = {
  kind: "pane";
  paneId: string;
};

export type TabKind = "ssh" | "local";

export type TerminalTab = {
  id: string;
  kind: TabKind;
  title: string;
  server: SavedHost | null;
  paneTree: PaneNode;
  status: SessionStatus;
  notice: string;
  appearance: Appearance;
};

/** Text waiting for the multiline confirmation before it is pasted into a terminal. */
export type PendingPaste = {
  tabId: string;
  text: string;
  source: "clipboard" | "snippet";
  /** Send Enter after pasting (snippet "insert and run"). */
  execute: boolean;
};

/** Crabshell's own terminal context menu (replaces the WebView menu). */
export type TerminalContextMenu = {
  tabId: string;
  x: number;
  y: number;
  hasSelection: boolean;
  canPaste: boolean;
};

/** A program asked to read the clipboard (OSC 52) and waits for the user's decision. */
export type PendingClipboardRead = {
  tabId: string;
};

export type TerminalSnapshot = {
  tabs: TerminalTab[];
  activeTabId: string | null;
  pendingPaste: PendingPaste | null;
  contextMenu: TerminalContextMenu | null;
  pendingClipboardRead: PendingClipboardRead | null;
};

export type SavedHost = {
  id: string;
  label: string;
  host: string;
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

export type ThemeMode = "system" | "light" | "dark";

export type AppSettings = {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  copyOnSelect: boolean;
  confirmMultilinePaste: boolean;
  appearances: Appearance[];
  defaultAppearanceId: string;
  themeMode: ThemeMode;
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

export type TerminalTab = {
  id: string;
  title: string;
  server: SavedHost | null;
  paneTree: PaneNode;
  status: SessionStatus;
  notice: string;
  appearance: Appearance;
};

export type TerminalSnapshot = {
  tabs: TerminalTab[];
  activeTabId: string | null;
  pendingPaste: { tabId: string; text: string } | null;
};

export type SavedHost = {
  id: string;
  label: string;
  host: string;
  username: string;
  identityFile: string;
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
};

export type TerminalSnapshot = {
  tabs: TerminalTab[];
  activeTabId: string | null;
  pendingPaste: { tabId: string; text: string } | null;
};

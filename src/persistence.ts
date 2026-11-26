import { terminalStore } from "./terminalStore";
import type { AppSettings, SavedHost, SessionState, SplitTarget, TerminalPaneState, TerminalTab } from "./terminalTypes";

/** What `load_persistent_data` returns (files in the app config directory). */
export type PersistentData = {
  servers: SavedHost[];
  settings: AppSettings;
  session: SessionState;
  serversFileExists: boolean;
  settingsFileExists: boolean;
  /** Data files that were unreadable or had invalid entries; the original is kept as `<name>.broken`. */
  recoveredFiles: string[];
};

/** Per-device UI convenience: the user hid the getting-started guide. */
const WELCOME_HIDDEN_KEY = "crabshell.welcome-hidden.v1";

export function readWelcomeHidden(): boolean {
  try {
    return localStorage.getItem(WELCOME_HIDDEN_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeWelcomeHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(WELCOME_HIDDEN_KEY, "true");
    else localStorage.removeItem(WELCOME_HIDDEN_KEY);
  } catch {
    // Not critical: the guide simply shows again next time.
  }
}

/**
 * Open tabs as stored in session.json: local shells and ids of saved servers, never connection
 * details. Connections that were not saved ("Connect only") are left out: null for such a tab,
 * and a split half running one is dropped.
 */
export function sessionTabsOf(tabs: TerminalTab[], savedServerIds: ReadonlySet<string>): (SessionState["tabs"][number] | null)[] {
  const serverIdOf = (pane: TerminalPaneState) => pane.kind === "ssh" && pane.server && savedServerIds.has(pane.server.id) ? pane.server.id : "";
  return tabs.map((tab) => {
    const [first, second] = tab.panes;
    if (first.kind === "ssh" && !serverIdOf(first)) return null;
    const secondValid = second && (second.kind === "local" || serverIdOf(second));
    return {
      kind: first.kind,
      serverId: serverIdOf(first),
      splitDirection: secondValid ? tab.split ?? "row" : "",
      splitKind: secondValid ? second.kind : "",
      splitServerId: secondValid ? serverIdOf(second) : "",
      title: tab.customTitle,
      color: tab.customColor,
    };
  });
}

/** Reopens the tabs of the last run; servers deleted in the meantime are skipped. */
export function restoreSession(session: SessionState, servers: SavedHost[]): void {
  const opened: string[] = [];
  for (const tab of session.tabs) {
    let tabId: string | null = null;
    if (tab.kind === "local") tabId = terminalStore.openLocalShell();
    else {
      const server = servers.find((item) => item.id === tab.serverId);
      if (server) tabId = terminalStore.openServer(server);
    }
    if (!tabId) continue;
    opened.push(tabId);
    if (tab.title) terminalStore.renameTab(tabId, tab.title);
    if (tab.color) terminalStore.setTabColor(tabId, tab.color);
    if (tab.splitDirection) {
      const server = tab.splitKind === "ssh" ? servers.find((item) => item.id === tab.splitServerId) : undefined;
      const target: SplitTarget | null = tab.splitKind === "local" ? { kind: "local" } : server ? { kind: "server", server } : null;
      if (target) terminalStore.splitTab(tabId, tab.splitDirection, target);
    }
  }
  const active = opened[Math.min(session.activeIndex, opened.length - 1)];
  if (active) terminalStore.activateTab(active);
}

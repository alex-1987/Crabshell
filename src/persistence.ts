import { defaultSettings } from "./appearance";
import { terminalStore } from "./terminalStore";
import type { AppSettings, SavedHost, SessionState, SplitTarget, TerminalPaneState, TerminalTab } from "./terminalTypes";

/** What `load_persistent_data` returns (files in the app config directory). */
export type PersistentData = {
  servers: SavedHost[];
  settings: AppSettings;
  session: SessionState;
  serversFileExists: boolean;
  settingsFileExists: boolean;
};

// Early versions kept servers and the sidebar layout in localStorage. They are migrated
// to the config files once and then removed.
const HOSTS_STORAGE_KEY = "crabshell.saved-hosts.v1";
const LEGACY_HOST_STORAGE_KEY = "crabshell.saved-host.v1";
const SIDEBAR_WIDTH_KEY = "crabshell.sidebar-width.v1";
const SIDEBAR_COLLAPSED_KEY = "crabshell.sidebar-collapsed.v1";

function normalizeSavedHost(value: unknown): SavedHost | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as Partial<SavedHost>;
  if (typeof saved.host !== "string" || !saved.host.trim()) return null;
  return {
    id: typeof saved.id === "string" && saved.id ? saved.id : crypto.randomUUID(),
    label: typeof saved.label === "string" ? saved.label : "",
    host: saved.host,
    port: typeof saved.port === "number" && Number.isInteger(saved.port) && saved.port >= 1 && saved.port <= 65535 ? saved.port : 22,
    username: typeof saved.username === "string" ? saved.username : "",
    identityFile: typeof saved.identityFile === "string" ? saved.identityFile : "",
    appearanceId: typeof saved.appearanceId === "string" ? saved.appearanceId : "",
    category: typeof saved.category === "string" ? saved.category.trim().slice(0, 48) : "",
  };
}

export function loadLegacyServers(): SavedHost[] {
  try {
    const stored = localStorage.getItem(HOSTS_STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      return Array.isArray(parsed)
        ? parsed.map(normalizeSavedHost).filter((server): server is SavedHost => server !== null)
        : [];
    }
    const legacy = localStorage.getItem(LEGACY_HOST_STORAGE_KEY);
    const server = legacy ? normalizeSavedHost(JSON.parse(legacy)) : null;
    return server ? [server] : [];
  } catch {
    return [];
  }
}

export function loadLegacySettings(): AppSettings {
  try {
    const storedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return {
      ...defaultSettings,
      sidebarWidth: Number.isFinite(storedWidth) && storedWidth >= 180 && storedWidth <= 420
        ? Math.round(storedWidth)
        : 220,
      sidebarCollapsed: localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true",
    };
  } catch {
    return defaultSettings;
  }
}

export function clearLegacyStorage(): void {
  try {
    for (const key of [HOSTS_STORAGE_KEY, LEGACY_HOST_STORAGE_KEY, SIDEBAR_WIDTH_KEY, SIDEBAR_COLLAPSED_KEY]) localStorage.removeItem(key);
  } catch {
    // Nothing to clean up without storage access.
  }
}

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

/** Open tabs as stored in session.json: local shells and server ids, never connection details. */
export function sessionTabsOf(tabs: TerminalTab[]): SessionState["tabs"] {
  const serverIdOf = (pane: TerminalPaneState) => pane.kind === "ssh" ? pane.server?.id ?? "" : "";
  return tabs.map((tab) => {
    const [first, second] = tab.panes;
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

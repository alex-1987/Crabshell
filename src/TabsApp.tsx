import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { defaultSettings } from "./appearance";
import AboutDialog from "./AboutDialog";
import BrandMark from "./BrandMark";
import SettingsDialog from "./SettingsDialog";
import SnippetEditor from "./SnippetEditor";
import SnippetPicker from "./SnippetPicker";
import SnippetSidebar from "./SnippetSidebar";
import ServerList, { serverCategories } from "./ServerList";
import FilterChips from "./FilterChips";
import { deleteSnippet, listSnippets, saveSnippet, type Snippet } from "./snippets";
import TerminalContextMenu from "./TerminalContextMenu";
import SplitMenu from "./SplitMenu";
import SplitView from "./SplitView";
import { useTabDrag } from "./useTabDrag";
import { resolveLanguage, setLanguage, t, translateBackend } from "./i18n";
import { themeModeCycle, themeModeLabel, useUiTheme } from "./uiTheme";
import { terminalStore } from "./terminalStore";
import type { AppSettings, SavedHost, SessionState, SessionStatus, SplitDirection, SplitTarget, TerminalPaneState, TerminalTab } from "./terminalTypes";
import "./styles.css";

const HOSTS_STORAGE_KEY = "crabshell.saved-hosts.v1";
const LEGACY_HOST_STORAGE_KEY = "crabshell.saved-host.v1";
const SIDEBAR_WIDTH_KEY = "crabshell.sidebar-width.v1";
const SIDEBAR_COLLAPSED_KEY = "crabshell.sidebar-collapsed.v1";

function statusLabel(status: SessionStatus): string {
  return t(`status.${status}`);
}

function paneTitle(pane: TerminalPaneState): string {
  return pane.kind === "local" ? t("tabs.localShell") : pane.title;
}

/** Tab label: the pane title, or both titles for a split tab. */
function titleOf(tab: TerminalTab): string {
  return tab.panes.map(paneTitle).join(tab.split === "column" ? " / " : " | ");
}

function withShortcut(label: string, shortcut: string): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

function SplitIcon({ direction }: { direction: SplitDirection }) {
  return (
    <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 16 16" width="15">
      <rect height="12" rx="2" width="14" x="1" y="2" />
      {direction === "row" ? <path d="M8 2v12" /> : <path d="M1 8h14" />}
    </svg>
  );
}

type PersistentData = {
  servers: SavedHost[];
  settings: AppSettings;
  session: SessionState;
  serversFileExists: boolean;
  settingsFileExists: boolean;
};

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

function loadLegacyServers(): SavedHost[] {
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

function loadLegacySettings(): AppSettings {
  try {
    const storedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return {
      ...defaultSettings,
      sidebarWidth: Number.isFinite(storedWidth) && storedWidth >= 210 && storedWidth <= 420
        ? Math.round(storedWidth)
        : 280,
      sidebarCollapsed: localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true",
    };
  } catch {
    return defaultSettings;
  }
}

/** "user@host" plus ":port" when it is not the default. */
function serverAddress(server: SavedHost): string {
  return `${server.username ? `${server.username}@` : ""}${server.host}${server.port && server.port !== 22 ? `:${server.port}` : ""}`;
}

/** Terminal width (CSS px) kept free before a second side panel is hidden. */
const MIN_TERMINAL_WIDTH = 480;
/** Below this window width the panels overlay the terminal (see styles.css); only one fits. */
const OVERLAY_BREAKPOINT = 760;

type Panel = "servers" | "snippets";

/** Reopens the tabs of the last run; servers deleted in the meantime are skipped. */
function restoreSession(session: SessionState, servers: SavedHost[]) {
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
    if (tab.splitDirection) {
      const server = tab.splitKind === "ssh" ? servers.find((item) => item.id === tab.splitServerId) : undefined;
      const target: SplitTarget | null = tab.splitKind === "local" ? { kind: "local" } : server ? { kind: "server", server } : null;
      if (target) terminalStore.splitTab(tabId, tab.splitDirection, target);
    }
  }
  const active = opened[Math.min(session.activeIndex, opened.length - 1)];
  if (active) terminalStore.activateTab(active);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export default function TabsApp() {
  const [savedHosts, setSavedHosts] = useState<SavedHost[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>(defaultSettings);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [appearanceId, setAppearanceId] = useState("");
  const [category, setCategory] = useState("");
  /** Sidebar filters: one server category / one snippet tag (lower case), null shows all. */
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [serverQuery, setServerQuery] = useState("");
  /** Chooser for what a new split pane runs, anchored at a button or the context menu. */
  const [splitMenu, setSplitMenu] = useState<{ direction: SplitDirection; x: number; y: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarNotice, setSidebarNotice] = useState("");
  const [snippetPanelOpen, setSnippetPanelOpen] = useState(false);
  const [snippetPanelWidth, setSnippetPanelWidth] = useState(280);
  /** Which panel wins when both are open but the window is too narrow for both. */
  const [lastOpenedPanel, setLastOpenedPanel] = useState<Panel>("servers");
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [sessionRestored, setSessionRestored] = useState(false);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [snippetsReady, setSnippetsReady] = useState(false);
  const [snippetError, setSnippetError] = useState("");
  const [snippetNotice, setSnippetNotice] = useState("");
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => undefined);
  }, []);
  const sidebarWidthRef = useRef(sidebarWidth);
  const settingsRef = useRef<AppSettings>(defaultSettings);
  const snippetPanelWidthRef = useRef(snippetPanelWidth);
  const resizingRef = useRef<"servers" | "snippets" | null>(null);
  sidebarWidthRef.current = sidebarWidth;
  snippetPanelWidthRef.current = snippetPanelWidth;

  const [systemLocale, setSystemLocale] = useState<string | null>(null);
  useEffect(() => {
    void invoke<string | null>("system_locale").then(setSystemLocale).catch(() => undefined);
  }, []);
  // Set synchronously during render so every t() call below (and in children) uses it.
  setLanguage(resolveLanguage(appSettings.language, systemLocale));

  useUiTheme(appSettings.themeMode, appSettings.uiScale);

  const terminalSnapshot = useSyncExternalStore(terminalStore.subscribe, terminalStore.getSnapshot);
  const activeTab = terminalSnapshot.tabs.find((tab) => tab.id === terminalSnapshot.activeTabId) ?? null;
  const canInsertSnippet = activeTab?.status === "connected";
  const tabDrag = useTabDrag(terminalSnapshot.tabs, terminalSnapshot.activeTabId, titleOf);

  // Tag chips for the snippet panel (tags compare case-insensitively, first spelling wins).
  const tagChips = (() => {
    const tags = new Map<string, { key: string; label: string; count: number }>();
    for (const snippet of snippets) {
      for (const tag of new Set(snippet.tags.map((item) => item.toLowerCase()))) {
        const label = snippet.tags.find((item) => item.toLowerCase() === tag) ?? tag;
        const entry = tags.get(tag) ?? { key: tag, label, count: 0 };
        entry.count += 1;
        tags.set(tag, entry);
      }
    }
    return [...tags.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  })();
  const activeTag = tagFilter !== null && tagChips.some((chip) => chip.key === tagFilter) ? tagFilter : null;
  const visibleSnippets = activeTag === null ? snippets : snippets.filter((snippet) => snippet.tags.some((tag) => tag.toLowerCase() === activeTag));

  // Both panels only stay open side by side when the terminal keeps enough room;
  // otherwise the most recently opened one is shown (the other stays "open" and returns when it fits).
  const zoom = appSettings.uiScale / 100;
  const bothPanelsFit = viewportWidth >= OVERLAY_BREAKPOINT
    && viewportWidth >= (sidebarWidth + snippetPanelWidth + 10 + MIN_TERMINAL_WIDTH) * zoom;
  const bothOpen = !sidebarCollapsed && snippetPanelOpen;
  const showServers = !sidebarCollapsed && (!bothOpen || bothPanelsFit || lastOpenedPanel === "servers");
  const showSnippets = snippetPanelOpen && (!bothOpen || bothPanelsFit || lastOpenedPanel === "snippets");

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Remember open tabs (local shells and server ids, nothing else) for the next start.
  const sessionTabs = terminalSnapshot.tabs.map((tab) => {
    const [first, second] = tab.panes;
    const serverIdOf = (pane: TerminalPaneState) => pane.kind === "ssh" ? pane.server?.id ?? "" : "";
    const secondValid = second && (second.kind === "local" || serverIdOf(second));
    return {
      kind: first.kind,
      serverId: serverIdOf(first),
      splitDirection: secondValid ? tab.split ?? "row" : "",
      splitKind: secondValid ? second.kind : "",
      splitServerId: secondValid ? serverIdOf(second) : "",
    };
  });
  const sessionKey = JSON.stringify([sessionTabs, terminalSnapshot.tabs.findIndex((tab) => tab.id === terminalSnapshot.activeTabId)]);
  useEffect(() => {
    if (!sessionRestored) return;
    const [tabs, activeIndex] = JSON.parse(sessionKey) as [SessionState["tabs"], number];
    const session: SessionState = appSettings.restoreTabs
      ? { tabs: tabs.filter((tab) => tab.kind === "local" || tab.serverId), activeIndex: Math.max(0, activeIndex) }
      : { tabs: [], activeIndex: 0 };
    const timer = window.setTimeout(() => void invoke("save_session", { session }).catch(() => undefined), 300);
    return () => window.clearTimeout(timer);
  }, [sessionKey, sessionRestored, appSettings.restoreTabs]);

  useEffect(() => {
    let mounted = true;
    listSnippets()
      .then((list) => {
        if (!mounted) return;
        setSnippets(list.snippets);
        if (list.recovered) setSnippetNotice(t("snippets.recovered"));
      })
      .catch((error: unknown) => {
        if (mounted) setSnippetError(t("snippets.loadFailed", { error: translateBackend(error) }));
      })
      .finally(() => {
        if (mounted) setSnippetsReady(true);
      });
    terminalStore.onSnippetShortcut(() => setPickerOpen(true));
    terminalStore.onSplitShortcut((direction, at) => requestSplitRef.current(direction, null, at));
    return () => {
      mounted = false;
      terminalStore.onSnippetShortcut(null);
      terminalStore.onSplitShortcut(null);
    };
  }, []);

  function insertSnippet(snippet: Snippet, execute: boolean) {
    setPickerOpen(false);
    terminalStore.insertSnippet(snippet.text, execute);
  }

  /** Already split: change the direction. Otherwise ask what the new pane should run. */
  function requestSplit(direction: SplitDirection, anchor: DOMRect | null, at: { x: number; y: number } | null = null) {
    const tab = terminalSnapshot.tabs.find((item) => item.id === terminalSnapshot.activeTabId);
    if (!tab) return;
    if (tab.panes.length > 1) {
      terminalStore.setSplitDirection(tab.id, direction);
      return;
    }
    const x = anchor ? anchor.right - 260 : at?.x ?? window.innerWidth / 2;
    const y = anchor ? anchor.bottom + 6 : at?.y ?? window.innerHeight / 3;
    setSplitMenu({ direction, x, y });
  }
  const requestSplitRef = useRef(requestSplit);
  requestSplitRef.current = requestSplit;

  function chooseSplit(target: SplitTarget) {
    if (!splitMenu) return;
    setSplitMenu(null);
    terminalStore.splitActiveTab(splitMenu.direction, target);
  }

  function closeSplitMenu() {
    setSplitMenu(null);
    terminalStore.focusActiveTerminal();
  }

  function closePicker() {
    setPickerOpen(false);
    terminalStore.focusActiveTerminal();
  }

  function manageSnippets() {
    setPickerOpen(false);
    if (!showSnippets) toggleSnippetPanel();
  }

  async function storeSnippet(snippet: Snippet) {
    const next = await saveSnippet(snippet);
    setSnippets(next);
    setSnippetError("");
    setSnippetNotice(t("snippets.savedNotice"));
    setEditingSnippet(null);
  }

  function duplicateSnippet(snippet: Snippet) {
    void storeSnippet({ ...snippet, id: crypto.randomUUID(), name: t("snippets.copySuffix", { name: snippet.name }).slice(0, 128) })
      .catch((error: unknown) => setSnippetError(t("snippets.saveFailed", { error: translateBackend(error) })));
  }

  function removeSnippet(snippet: Snippet) {
    deleteSnippet(snippet.id)
      .then((next) => {
        setSnippets(next);
        setSnippetError("");
        setSnippetNotice(t("snippets.deleted"));
      })
      .catch((error: unknown) => setSnippetError(t("snippets.saveFailed", { error: translateBackend(error) })));
  }

  useEffect(() => {
    let mounted = true;

    async function loadPersistentData() {
      try {
        const data = await invoke<PersistentData>("load_persistent_data");
        const nextServers = data.serversFileExists ? data.servers : loadLegacyServers();
        const nextSettings = data.settingsFileExists ? data.settings : loadLegacySettings();

        if (!data.serversFileExists) await invoke("save_servers", { servers: nextServers });
        if (!data.settingsFileExists) await invoke("save_settings", { settings: nextSettings });
        if (!mounted) return;

        setSavedHosts(nextServers);
        setSidebarWidth(nextSettings.sidebarWidth);
        setSidebarCollapsed(nextSettings.sidebarCollapsed);
        setSnippetPanelOpen(nextSettings.snippetPanelOpen);
        setSnippetPanelWidth(nextSettings.snippetPanelWidth);
        setAppSettings(nextSettings);
        sidebarWidthRef.current = nextSettings.sidebarWidth;
        snippetPanelWidthRef.current = nextSettings.snippetPanelWidth;
        settingsRef.current = nextSettings;
        terminalStore.setClipboardPreferences(nextSettings);
        terminalStore.setKeybindings(nextSettings.keybindings);
        terminalStore.setAppearances(nextSettings.appearances, nextSettings.defaultAppearanceId, nextSettings.localAppearanceId);
        localStorage.removeItem(HOSTS_STORAGE_KEY);
        localStorage.removeItem(LEGACY_HOST_STORAGE_KEY);
        localStorage.removeItem(SIDEBAR_WIDTH_KEY);
        localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
        setStorageError("");
        if (nextSettings.restoreTabs) restoreSession(data.session, nextServers);
        setSessionRestored(true);
      } catch (error) {
        if (mounted) setStorageError(t("notice.loadFailed", { error: translateBackend(error) }));
      } finally {
        if (mounted) setStorageReady(true);
      }
    }

    void loadPersistentData();
    return () => {
      mounted = false;
    };
  }, []);

  function openEditor(server?: SavedHost) {
    setEditingId(server?.id ?? null);
    setLabel(server?.label ?? "");
    setHost(server?.host ?? "");
    setPort(String(server?.port ?? 22));
    setUsername(server?.username ?? "");
    setIdentityFile(server?.identityFile ?? "");
    setAppearanceId(server?.appearanceId ?? "");
    // A new server starts in the category that is currently filtered.
    setCategory(server ? server.category : categoryFilter && categoryFilter.trim() ? categoryFilter : "");
    setSidebarNotice("");
    setEditorOpen(true);
  }

  async function saveHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!storageReady || storageError) return;
    const savedHost = host.trim();
    if (!savedHost) {
      setSidebarNotice(t("notice.enterHost"));
      return;
    }
    const savedPort = Number(port.trim() || "22");
    if (!Number.isInteger(savedPort) || savedPort < 1 || savedPort > 65535) {
      setSidebarNotice(t("notice.invalidPort"));
      return;
    }

    // Reuse the spelling of an existing category ("homelab" → "HomeLab").
    const typedCategory = category.trim().slice(0, 48);
    const savedCategory = serverCategories(savedHosts).find((item) => item.localeCompare(typedCategory, undefined, { sensitivity: "base" }) === 0) ?? typedCategory;

    const server: SavedHost = {
      id: editingId ?? crypto.randomUUID(),
      label: label.trim(),
      host: savedHost,
      port: savedPort,
      username: username.trim(),
      identityFile,
      // The design may have been deleted while this dialog was open.
      appearanceId: appSettings.appearances.some((item) => item.id === appearanceId) ? appearanceId : "",
      category: savedCategory,
    };
    const nextServers = editingId
      ? savedHosts.map((saved) => saved.id === editingId ? server : saved)
      : [...savedHosts, server];

    try {
      await invoke("save_servers", { servers: nextServers });
      setSavedHosts(nextServers);
      terminalStore.updateServers(nextServers);
      setSidebarNotice(editingId ? t("notice.serverUpdated") : t("notice.serverSaved"));
      setEditorOpen(false);
    } catch (error) {
      setStorageError(t("notice.saveServersFailed", { error: translateBackend(error) }));
    }
  }

  async function removeHost(id: string) {
    if (!storageReady || storageError) return;
    const nextServers = savedHosts.filter((server) => server.id !== id);
    try {
      await invoke("save_servers", { servers: nextServers });
      setSavedHosts(nextServers);
      setConfirmDeleteId(null);
      setSidebarNotice(t("notice.serverRemoved"));
    } catch (error) {
      setStorageError(t("notice.saveServersFailed", { error: translateBackend(error) }));
    }
  }

  async function choosePrivateKey() {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        defaultPath: await join(await homeDir(), ".ssh"),
        title: t("server.pickKeyTitle"),
      });
      if (typeof selected === "string") setIdentityFile(selected);
    } catch (error) {
      setSidebarNotice(t("notice.filePickerFailed", { error: translateBackend(error) }));
    }
  }

  function openServer(server: SavedHost) {
    if (!storageReady || storageError) return;
    terminalStore.openServer(server);
  }

  function applySettings(settings: AppSettings): AppSettings {
    const normalized = { ...settings, sidebarWidth: Math.round(settings.sidebarWidth), snippetPanelWidth: Math.round(settings.snippetPanelWidth) };
    settingsRef.current = normalized;
    setAppSettings(normalized);
    terminalStore.setClipboardPreferences(normalized);
    terminalStore.setKeybindings(normalized.keybindings);
    terminalStore.setAppearances(normalized.appearances, normalized.defaultAppearanceId, normalized.localAppearanceId);
    return normalized;
  }

  function persistSettings(settings: AppSettings) {
    const normalized = applySettings(settings);
    void invoke("save_settings", { settings: normalized }).catch((error: unknown) => {
      setStorageError(t("notice.saveSettingsFailed", { error: translateBackend(error) }));
    });
  }

  async function saveSettingsDialog(settings: AppSettings) {
    // Keep panel layout from the live settings; the dialog does not edit it.
    const live = settingsRef.current;
    const next = { ...settings, sidebarWidth: live.sidebarWidth, sidebarCollapsed: live.sidebarCollapsed, snippetPanelOpen: live.snippetPanelOpen, snippetPanelWidth: live.snippetPanelWidth };
    await invoke("save_settings", { settings: next });
    applySettings(next);

    // Servers pointing at a deleted design fall back to the default design.
    const knownIds = new Set(next.appearances.map((item) => item.id));
    if (savedHosts.some((server) => server.appearanceId && !knownIds.has(server.appearanceId))) {
      const cleaned = savedHosts.map((server) => server.appearanceId && !knownIds.has(server.appearanceId) ? { ...server, appearanceId: "" } : server);
      await invoke("save_servers", { servers: cleaned });
      setSavedHosts(cleaned);
      terminalStore.updateServers(cleaned);
    }
    setSettingsOpen(false);
  }

  function toggleSidebar() {
    if (!storageReady || storageError) return;
    // Open but pushed aside by the snippet panel (narrow window): bring it to the front.
    if (!sidebarCollapsed && !showServers) {
      setLastOpenedPanel("servers");
      return;
    }
    const collapsed = !sidebarCollapsed;
    setSidebarCollapsed(collapsed);
    if (!collapsed) setLastOpenedPanel("servers");
    persistSettings({ ...settingsRef.current, sidebarCollapsed: collapsed });
  }

  function toggleSnippetPanel() {
    if (!storageReady || storageError) return;
    if (snippetPanelOpen && !showSnippets) {
      setLastOpenedPanel("snippets");
      return;
    }
    const open = !snippetPanelOpen;
    setSnippetPanelOpen(open);
    if (open) setLastOpenedPanel("snippets");
    persistSettings({ ...settingsRef.current, snippetPanelOpen: open });
    if (!open) terminalStore.focusActiveTerminal();
  }

  function clampPanelWidth(width: number) {
    return Math.round(Math.min(420, Math.max(210, width)));
  }

  function setPanelWidth(panel: "servers" | "snippets", width: number) {
    const next = clampPanelWidth(width);
    if (panel === "servers") {
      sidebarWidthRef.current = next;
      setSidebarWidth(next);
    } else {
      snippetPanelWidthRef.current = next;
      setSnippetPanelWidth(next);
    }
  }

  function persistPanelWidths() {
    persistSettings({ ...settingsRef.current, sidebarWidth: sidebarWidthRef.current, snippetPanelWidth: snippetPanelWidthRef.current });
  }

  function handleResizeKey(panel: "servers" | "snippets", event: KeyboardEvent<HTMLDivElement>) {
    if (!storageReady || storageError || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    // The snippet panel sits on the right, so dragging left makes it wider.
    const grow = (event.key === "ArrowRight") === (panel === "servers");
    const current = panel === "servers" ? sidebarWidthRef.current : snippetPanelWidthRef.current;
    setPanelWidth(panel, current + (grow ? 16 : -16));
    persistPanelWidths();
  }

  function finishResize() {
    if (!resizingRef.current) return;
    resizingRef.current = null;
    persistPanelWidths();
  }

  function resizerProps(panel: "servers" | "snippets") {
    return {
      "aria-controls": panel === "servers" ? "server-sidebar" : "snippet-panel",
      "aria-label": panel === "servers" ? t("sidebar.resize") : t("snippetPanel.resize"),
      "aria-orientation": "vertical" as const,
      "aria-valuemax": 420,
      "aria-valuemin": 210,
      "aria-valuenow": panel === "servers" ? sidebarWidth : snippetPanelWidth,
      className: "sidebar-resizer",
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => handleResizeKey(panel, event),
      onLostPointerCapture: finishResize,
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (!storageReady || storageError) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        resizingRef.current = panel;
        event.preventDefault();
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        if (resizingRef.current === "servers") setPanelWidth("servers", event.clientX);
        else if (resizingRef.current === "snippets") setPanelWidth("snippets", window.innerWidth - event.clientX);
      },
      onPointerUp: finishResize,
      role: "separator",
      tabIndex: 0,
    };
  }

  const shellColumns = [
    ...(showServers ? ["var(--sidebar-col)", "5px"] : []),
    "minmax(0, 1fr)",
    ...(showSnippets ? ["5px", "var(--snippet-col)"] : []),
  ].join(" ");
  const shellStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--snippet-panel-width": `${snippetPanelWidth}px`,
    "--shell-columns": shellColumns,
  } as CSSProperties;

  return (
    <div className={`app-shell${showServers ? "" : " sidebar-collapsed"}${showSnippets ? " snippet-panel-open" : ""}`} style={shellStyle}>
      {showServers && (
        <>
          <aside className="sidebar" id="server-sidebar">
            <div className="sidebar-brand-row">
              <div className="brand-row">
                <BrandMark />
                <div><div className="brand-name">crabshell</div><div className="brand-caption">LOCAL SSH WORKSPACE</div></div>
              </div>
              <button aria-label={t("sidebar.hide")} className="icon-button sidebar-toggle" disabled={!storageReady} onClick={toggleSidebar} title={t("sidebar.hide")} type="button"><span aria-hidden="true">‹</span></button>
            </div>
            <div className="privacy-line"><span className="privacy-indicator" /><span>{t("sidebar.privacy")}</span></div>
            <div className="server-list-heading">
              <div><h1>{t("sidebar.servers")}</h1><span>{savedHosts.length}</span></div>
              <button aria-label={t("sidebar.addServer")} className="icon-button add-server-button" disabled={!storageReady || Boolean(storageError)} onClick={() => openEditor()} title={t("sidebar.addServer")} type="button"><span aria-hidden="true">+</span></button>
            </div>
            {sidebarNotice && <div aria-live="polite" className="page-notice">{sidebarNotice}</div>}
            {storageReady && !storageError && savedHosts.length > 0 && (
              <div className="sidebar-search">
                <span aria-hidden="true" className="sidebar-search-icon">⌕</span>
                <input
                  aria-label={t("sidebar.search")}
                  autoComplete="off"
                  onChange={(event) => setServerQuery(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Escape" && serverQuery) { event.preventDefault(); event.stopPropagation(); setServerQuery(""); } }}
                  placeholder={t("sidebar.search")}
                  spellCheck={false}
                  type="search"
                  value={serverQuery}
                />
                {serverQuery && <button aria-label={t("sidebar.clearSearch")} className="sidebar-search-clear" onClick={() => setServerQuery("")} title={t("sidebar.clearSearch")} type="button">×</button>}
              </div>
            )}
            <nav aria-label={t("sidebar.savedServers")} className="saved-server-list">
              {!storageReady ? <div className="sidebar-empty">{t("sidebar.loading")}</div> : storageError ? <div aria-live="polite" className="sidebar-storage-error">{storageError}</div> : savedHosts.length === 0 ? <div className="sidebar-empty">{t("sidebar.empty")}</div> : (
                <ServerList
                  activeCategory={categoryFilter}
                  address={serverAddress}
                  collapsed={collapsedGroups}
                  confirmDeleteId={confirmDeleteId}
                  disabled={!storageReady || Boolean(storageError)}
                  doubleClick={appSettings.serverOpenClick === "double"}
                  keyName={fileName}
                  onCategory={setCategoryFilter}
                  onConfirmDelete={setConfirmDeleteId}
                  onEdit={openEditor}
                  onOpen={openServer}
                  onRemove={(id) => void removeHost(id)}
                  query={serverQuery}
                  onToggleGroup={(key) => setCollapsedGroups((current) => {
                    const next = new Set(current);
                    if (!next.delete(key)) next.add(key);
                    return next;
                  })}
                  servers={savedHosts}
                />
              )}
            </nav>
            <div className="sidebar-bottom">
              <div className="open-ssh-badge"><span>SSH</span><div><strong>OpenSSH</strong><small>{t("sidebar.systemInstall")}</small></div></div>
              <div className="sidebar-meta">{t("sidebar.meta")}</div>
            </div>
          </aside>
          <div {...resizerProps("servers")} />
          <button aria-label={t("sidebar.close")} className="sidebar-backdrop" onClick={toggleSidebar} tabIndex={-1} type="button" />
        </>
      )}

      <main className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <button aria-label={showServers ? t("sidebar.hide") : t("sidebar.show")} aria-controls="server-sidebar" aria-pressed={showServers} className="panel-toggle" disabled={!storageReady || Boolean(storageError)} onClick={toggleSidebar} title={showServers ? t("sidebar.hide") : t("sidebar.show")} type="button"><span aria-hidden="true">☰</span><span className="panel-toggle-label">{t("sidebar.servers")}</span></button>
            <div className="breadcrumb"><span>CRABSHELL</span><i>/</i><strong>{t("topbar.terminal")}</strong></div>
          </div>
          <div className="topbar-actions">
            <span className="active-host-label">{activeTab ? titleOf(activeTab) : t("topbar.noSession")}</span>
            <span className={`connection-label label-${activeTab?.status ?? "disconnected"}`}><span className="status-led" />{statusLabel(activeTab?.status ?? "disconnected")}</span>
            {activeTab && (activeTab.status === "disconnected" || activeTab.status === "failed") && (
              <button className="connect-button" onClick={() => void terminalStore.connect(activeTab.id)} type="button">{activeTab.kind === "local" ? t("topbar.restart") : t("topbar.reconnect")} <span aria-hidden="true">↻</span></button>
            )}
            <button className="disconnect-button" disabled={!activeTab || (activeTab.status !== "connected" && activeTab.status !== "connecting")} onClick={() => activeTab && void terminalStore.disconnect(activeTab.id)} type="button"><span aria-hidden="true">■</span> {activeTab?.kind === "local" ? t("topbar.stop") : t("topbar.disconnect")}</button>
            <button aria-controls="snippet-panel" aria-label={showSnippets ? t("snippetPanel.hide") : t("snippetPanel.show")} aria-pressed={showSnippets} className="panel-toggle" disabled={!storageReady || Boolean(storageError)} onClick={toggleSnippetPanel} title={showSnippets ? t("snippetPanel.hide") : t("snippetPanel.show")} type="button"><span aria-hidden="true">{"{}"}</span><span className="panel-toggle-label">{t("sidebar.snippets")}</span></button>
            <button
              aria-label={t("topbar.themeToggle", { mode: themeModeLabel(appSettings.themeMode) })}
              className="icon-button settings-button theme-toggle"
              disabled={!storageReady || Boolean(storageError)}
              onClick={() => {
                const next = themeModeCycle[(themeModeCycle.indexOf(appSettings.themeMode) + 1) % themeModeCycle.length];
                persistSettings({ ...settingsRef.current, themeMode: next });
              }}
              title={t("topbar.themeTitle", { mode: themeModeLabel(appSettings.themeMode) })}
              type="button"
            >
              <span aria-hidden="true">{appSettings.themeMode === "system" ? "◐" : appSettings.themeMode === "light" ? "☀" : "☾"}</span>
            </button>
            <button aria-label={t("about.open")} className="icon-button settings-button" onClick={() => setAboutOpen(true)} title={t("about.open")} type="button"><span aria-hidden="true">ⓘ</span></button>
            <button aria-label={t("topbar.openSettings")} className="icon-button settings-button" disabled={!storageReady || Boolean(storageError)} onClick={() => setSettingsOpen(true)} title={t("topbar.settings")} type="button"><span aria-hidden="true">⚙</span></button>
          </div>
        </header>

        <div aria-label={t("tabs.label")} className="terminal-tabs" role="tablist">
          {terminalSnapshot.tabs.map((tab) => (
            <div className={`terminal-tab${tab.id === terminalSnapshot.activeTabId ? " terminal-tab-active" : ""}${tab.id === tabDrag.draggingTabId ? " terminal-tab-dragging" : ""}`} data-tab-id={tab.id} key={tab.id} style={{ "--tab-color": tab.appearance.tabColor } as CSSProperties}>
              <button aria-selected={tab.id === terminalSnapshot.activeTabId} className="terminal-tab-select" onClick={() => terminalStore.activateTab(tab.id)} role="tab" title={`${titleOf(tab)} · ${t("drag.hint")}`} type="button" {...tabDrag.tabHandlers(tab.id)}>
                <span className={`tab-status-dot status-${tab.status}`} />
                {tab.kind === "local" && <span aria-label={t("tabs.local")} className="tab-kind-local">&gt;_</span>}
                <span className="terminal-tab-title">{titleOf(tab)}</span>
              </button>
              <button aria-label={t("tabs.close", { name: titleOf(tab) })} className="terminal-tab-close" onClick={() => void terminalStore.closeTab(tab.id)} title={t("tabs.closeTitle")} type="button">×</button>
            </div>
          ))}
          <button aria-label={t("tabs.openLocal")} className="icon-button add-tab-button" onClick={() => terminalStore.openLocalShell()} title={t("tabs.openLocalTitle")} type="button"><span aria-hidden="true">+</span></button>
        </div>

        <div className={`terminal-panels${terminalSnapshot.tabs.length === 0 ? " terminal-panels-empty" : ""}`}>
          {terminalSnapshot.tabs.length === 0 ? (
            <div className="terminal-empty"><span>{t("tabs.empty")}</span></div>
          ) : terminalSnapshot.tabs.map((tab: TerminalTab) => (
            <section aria-label={t("terminal.panel", { name: titleOf(tab) })} className={`terminal-tab-panel${tab.id === terminalSnapshot.activeTabId ? " terminal-tab-panel-active" : ""}`} key={tab.id} role="tabpanel" style={{ display: tab.id === terminalSnapshot.activeTabId ? "flex" : "none" }}>
              <div className="terminal-frame">
                <div className="terminal-heading">
                  <div className="terminal-target">
                    <div className="target-icon" aria-hidden="true"><span /></div>
                    <div><div className="target-name">{titleOf(tab)}</div><div className="target-subtitle">{tab.kind === "local" ? t("terminal.localSubtitle") : t("terminal.sshSubtitle")}</div></div>
                  </div>
                  <div className="terminal-heading-actions">
                    <div className="transport-tag"><span /> {tab.kind === "local" ? t("terminal.local") : "OPENSSH"} <b>·</b> PTY</div>
                    <div aria-label={t("split.group")} className="split-buttons" role="group">
                      {(["row", "column"] as const).map((direction) => {
                        const label = tab.panes.length > 1
                          ? t(direction === "row" ? "menu.layoutRow" : "menu.layoutColumn")
                          : withShortcut(t(direction === "row" ? "menu.splitRow" : "menu.splitColumn"), terminalStore.shortcutLabel(direction === "row" ? "splitRight" : "splitDown"));
                        return (
                          <button aria-label={label} aria-pressed={tab.panes.length > 1 && tab.split === direction} className="icon-button split-button" key={direction} onClick={(event) => requestSplit(direction, event.currentTarget.getBoundingClientRect())} title={label} type="button">
                            <SplitIcon direction={direction} />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <SplitView paneTitle={paneTitle} statusLabel={statusLabel} tab={tab} />
                <div className="terminal-statusbar">
                  <div className="status-message"><span className={`status-led status-${tab.status}`} />{tab.notice || statusLabel(tab.status)}</div>
                  <div className="terminal-metrics">{tab.status === "connected" ? t("terminal.sessionActive") : t("terminal.localSession")}<span>UTF-8</span></div>
                </div>
              </div>
            </section>
          ))}
        </div>

        <footer className="workspace-footer">
          <span>Crabshell <b>{appVersion}</b></span>
          <span>{[
            [terminalStore.shortcutLabel("copy"), terminalStore.shortcutLabel("paste"), t("footer.copyPaste")],
            [terminalStore.shortcutLabel("snippets"), t("footer.snippets")],
            [terminalStore.shortcutLabel("localShell"), t("footer.localShell")],
            [terminalStore.shortcutLabel("splitRight"), terminalStore.shortcutLabel("splitDown"), t("footer.split")],
            [terminalStore.shortcutLabel("close"), t("footer.close")],
          ].map((parts) => {
            const label = parts.pop() ?? "";
            const keys = parts.filter(Boolean).join(" / ");
            return keys ? `${keys} ${label}` : "";
          }).filter(Boolean).join(" · ")}</span>
        </footer>
      </main>

      {showSnippets && (
        <>
          <div {...resizerProps("snippets")} />
          <aside aria-label={t("sidebar.snippets")} className="sidebar snippet-panel" id="snippet-panel">
            <div className="snippet-panel-top">
              <button aria-label={t("snippetPanel.hide")} className="icon-button sidebar-toggle" onClick={toggleSnippetPanel} title={t("snippetPanel.hide")} type="button"><span aria-hidden="true">›</span></button>
            </div>
            <div className="server-list-heading">
              <div><h1>{t("sidebar.snippets")}</h1><span>{snippets.length}</span></div>
              <div className="snippet-panel-actions">
                <button aria-label={t("snippets.openPicker")} className="icon-button add-server-button" onClick={() => setPickerOpen(true)} title={t("snippets.openPicker")} type="button"><span aria-hidden="true">⌕</span></button>
                <button aria-label={t("snippets.add")} className="icon-button add-server-button" disabled={!snippetsReady || Boolean(snippetError)} onClick={() => { setSnippetNotice(""); setEditingSnippet({ id: "", name: "", text: "", tags: [] }); }} title={t("snippets.add")} type="button"><span aria-hidden="true">+</span></button>
              </div>
            </div>
            {snippetNotice && <div aria-live="polite" className="page-notice">{snippetNotice}</div>}
            {snippetsReady && !snippetError && <FilterChips active={activeTag} chips={tagChips} label={t("snippets.tagFilter")} onChange={setTagFilter} />}
            <nav aria-label={t("snippets.saved")} className="saved-server-list">
              {!snippetsReady ? <div className="sidebar-empty">{t("sidebar.loading")}</div> : snippetError ? <div aria-live="polite" className="sidebar-storage-error">{snippetError}</div> : (
                <SnippetSidebar
                  canInsert={canInsertSnippet}
                  disabled={!snippetsReady}
                  doubleClick={appSettings.snippetInsertClick === "double"}
                  onDelete={removeSnippet}
                  onDuplicate={duplicateSnippet}
                  onEdit={(snippet) => { setSnippetNotice(""); setEditingSnippet(snippet); }}
                  onInsert={(snippet, execute) => insertSnippet(snippet, execute)}
                  activeTag={activeTag}
                  onTag={setTagFilter}
                  snippets={visibleSnippets}
                />
              )}
            </nav>
            <div className="snippet-sidebar-hint">{t("snippets.noPasswords")}</div>
          </aside>
          <button aria-label={t("snippetPanel.hide")} className="sidebar-backdrop snippet-panel-backdrop" onClick={toggleSnippetPanel} tabIndex={-1} type="button" />
        </>
      )}

      {terminalSnapshot.pendingPaste && (() => {
        const { text, source, execute } = terminalSnapshot.pendingPaste;
        const lines = text.split(/\r\n|\r|\n/);
        const lineCount = text.endsWith("\n") || text.endsWith("\r") ? lines.length - 1 : lines.length;
        const targetTab = terminalSnapshot.tabs.find((tab) => tab.id === terminalSnapshot.pendingPaste?.tabId);
        const preview = lines.slice(0, 12).join("\n") + (lines.length > 12 ? "\n…" : "");
        return (
          <div className="dialog-scrim" onKeyDown={(event) => { if (event.key === "Escape") terminalStore.cancelPendingPaste(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) terminalStore.cancelPendingPaste(); }} role="presentation">
            <section aria-labelledby="paste-title" aria-modal="true" className="server-dialog paste-dialog" role="dialog">
              <header className="dialog-heading">
                <div><div className="page-eyebrow">{source === "snippet" ? t("paste.snippetEyebrow") : t("paste.eyebrow")}</div><h2 id="paste-title">{source === "snippet" ? t("paste.snippetTitle") : t("paste.title")}</h2></div>
                <button aria-label={t("paste.cancelLabel")} className="icon-button" onClick={() => terminalStore.cancelPendingPaste()} type="button">×</button>
              </header>
              <div className="form-footnote">
                {t("paste.summary", { lines: lineCount, chars: text.length })} <strong>{targetTab ? titleOf(targetTab) : t("terminal.pane")}</strong>. {t("paste.warning")}{execute && <> <strong>{t("paste.runWarning")}</strong></>}
              </div>
              <pre className="paste-preview">{preview}</pre>
              <div className="editor-actions">
                <button autoFocus className="button button-secondary" onClick={() => terminalStore.cancelPendingPaste()} type="button">{t("common.cancel")}</button>
                <button className="button button-primary" onClick={() => terminalStore.confirmPendingPaste()} type="button">{execute ? t("paste.confirmRun") : t("paste.confirm")}</button>
              </div>
            </section>
          </div>
        );
      })()}

      {editorOpen && (
        <div className="dialog-scrim" onKeyDown={(event) => { if (event.key === "Escape") setEditorOpen(false); }} onMouseDown={(event) => { if (event.target === event.currentTarget) setEditorOpen(false); }} role="presentation">
          <section aria-labelledby="editor-title" aria-modal="true" className="server-dialog" role="dialog">
            <header className="dialog-heading">
              <div><div className="page-eyebrow">{t("server.eyebrow")}</div><h2 id="editor-title">{editingId ? t("server.editTitle") : t("server.addTitle")}</h2></div>
              <button aria-label={t("server.closeDialog")} className="icon-button" onClick={() => setEditorOpen(false)} type="button">×</button>
            </header>
            <form className="editor-form" onSubmit={saveHost}>
              <label className="field-label" htmlFor="label">{t("server.label")} <span>{t("server.optional")}</span></label>
              <input autoComplete="off" autoFocus id="label" name="label" onChange={(event) => setLabel(event.target.value)} placeholder={t("server.labelPlaceholder")} value={label} />
              <label className="field-label" htmlFor="category">{t("server.category")} <span>{t("server.optional")}</span></label>
              <input autoComplete="off" id="category" list="server-categories" maxLength={48} name="category" onChange={(event) => setCategory(event.target.value)} placeholder={t("server.categoryPlaceholder")} value={category} />
              <datalist id="server-categories">{serverCategories(savedHosts).map((item) => <option key={item} value={item} />)}</datalist>
              <label className="field-label" htmlFor="host">{t("server.host")} <span>{t("server.portLabel")}</span></label>
              <div className="host-port-row">
                <input autoComplete="off" id="host" name="host" onChange={(event) => setHost(event.target.value)} placeholder={t("server.hostPlaceholder")} spellCheck={false} value={host} required />
                <input aria-label={t("server.port")} autoComplete="off" className="port-input" id="port" inputMode="numeric" max={65535} min={1} name="port" onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))} placeholder="22" title={t("server.portHint")} type="text" value={port} />
              </div>
              <label className="field-label" htmlFor="username">{t("server.username")} <span>{t("server.optional")}</span></label>
              <input autoComplete="off" id="username" name="username" onChange={(event) => setUsername(event.target.value)} placeholder={t("server.usernamePlaceholder")} spellCheck={false} value={username} />
              <label className="field-label" htmlFor="identity-file">{t("server.privateKey")} <span>{t("server.optional")}</span></label>
              <div className="key-picker">
                <span className="key-picker-name" title={identityFile || undefined}>{identityFile ? fileName(identityFile) : t("server.noKey")}</span>
                <button className="button button-secondary key-picker-button" onClick={() => void choosePrivateKey()} type="button">{t("server.chooseFile")}</button>
                {identityFile && <button aria-label={t("server.removeKey")} className="button button-secondary key-picker-clear" onClick={() => setIdentityFile("")} title={t("server.removeKeyTitle")} type="button">×</button>}
              </div>
              <label className="field-label" htmlFor="appearance">{t("server.design")}</label>
              <div className="key-picker">
                <select id="appearance" onChange={(event) => setAppearanceId(event.target.value)} value={appearanceId}>
                  <option value="">{t("server.defaultDesign", { name: appSettings.appearances.find((item) => item.id === appSettings.defaultAppearanceId)?.name ?? "Crabshell" })}</option>
                  {appSettings.appearances.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <button className="button button-secondary key-picker-button" onClick={() => setSettingsOpen(true)} type="button">{t("server.editDesigns")}</button>
              </div>
              <div className="form-footnote">{t("server.footnote")}</div>
              {storageError && <div aria-live="polite" className="editor-notice">{storageError}</div>}
              <div className="editor-actions">
                <button className="button button-secondary" onClick={() => setEditorOpen(false)} type="button">{t("common.cancel")}</button>
                <button className="button button-primary" disabled={!storageReady || Boolean(storageError)} type="submit">{editingId ? t("server.saveChanges") : t("server.save")}</button>
              </div>
            </form>
          </section>
        </div>
      )}
      {terminalSnapshot.pendingClipboardRead && (() => {
        const targetTab = terminalSnapshot.tabs.find((tab) => tab.id === terminalSnapshot.pendingClipboardRead?.tabId);
        return (
          <div className="dialog-scrim" onKeyDown={(event) => { if (event.key === "Escape") terminalStore.answerClipboardRead("deny"); }} role="presentation">
            <section aria-labelledby="clip-read-title" aria-modal="true" className="server-dialog paste-dialog" role="dialog">
              <header className="dialog-heading">
                <div><div className="page-eyebrow">{t("clipRead.eyebrow")}</div><h2 id="clip-read-title">{t("clipRead.title")}</h2></div>
                <button aria-label={t("clipRead.deny")} className="icon-button" onClick={() => terminalStore.answerClipboardRead("deny")} type="button">×</button>
              </header>
              <div className="form-footnote">
                {t("clipRead.text", { name: targetTab ? titleOf(targetTab) : t("terminal.pane") })} <strong>{t("clipRead.warning")}</strong> {t("clipRead.retry")}
              </div>
              <div className="editor-actions">
                <button autoFocus className="button button-secondary" onClick={() => terminalStore.answerClipboardRead("deny")} type="button">{t("clipRead.deny")}</button>
                <button className="button button-primary" onClick={() => terminalStore.answerClipboardRead("session")} type="button">{t("clipRead.session")}</button>
              </div>
            </section>
          </div>
        );
      })()}
      {tabDrag.overlay}
      {splitMenu && activeTab && (
        <SplitMenu
          direction={splitMenu.direction}
          onChoose={chooseSplit}
          onClose={closeSplitMenu}
          sameLabel={titleOf(activeTab)}
          serverAddress={serverAddress}
          servers={savedHosts}
          x={splitMenu.x}
          y={splitMenu.y}
        />
      )}
      {terminalSnapshot.contextMenu && <TerminalContextMenu key={`${terminalSnapshot.contextMenu.x},${terminalSnapshot.contextMenu.y}`} menu={terminalSnapshot.contextMenu} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} version={appVersion} />}
      {pickerOpen && (
        <SnippetPicker canInsert={canInsertSnippet} onClose={closePicker} onInsert={insertSnippet} onManage={manageSnippets} snippets={snippets} />
      )}
      {editingSnippet && (
        <SnippetEditor onClose={() => setEditingSnippet(null)} onSave={storeSnippet} snippet={editingSnippet} />
      )}
      {/* Rendered last so it stacks above the server dialog when opened from there. */}
      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} onSave={saveSettingsDialog} servers={savedHosts} settings={appSettings} systemLocale={systemLocale} />
      )}
    </div>
  );
}

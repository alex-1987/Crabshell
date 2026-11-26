import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import AboutDialog from "./AboutDialog";
import { defaultSettings } from "./appearance";
import { ClipboardReadDialog, CloseConfirmDialog, PasteConfirmDialog } from "./ConfirmDialogs";
import { resolveLanguage, setLanguage, t, translateBackend } from "./i18n";
import { automaticTitleOf, runningSessionCount, serverAddress, statusLabel, tabColorOf, titleOf, withShortcut } from "./labels";
import { readWelcomeHidden, restoreSession, sessionTabsOf, writeWelcomeHidden, type PersistentData } from "./persistence";
import ServerDialog from "./ServerDialog";
import SshImportDialog from "./SshImportDialog";
import FilePanel, { type FileLocation } from "./FilePanel";
import { joinRemote, localFileName, sftpApi, sftpStore, type ConnectOptions } from "./sftp";
import UploadDialog, { type UploadRequest } from "./UploadDialog";
import { activeProxy } from "./proxy";
import { serverCategories, type ServerListProps } from "./ServerList";
import ServerSidebar, { type ServerFilters } from "./ServerSidebar";
import SettingsDialog from "./SettingsDialog";
import SnippetEditor from "./SnippetEditor";
import SnippetPanel from "./SnippetPanel";
import SnippetPicker from "./SnippetPicker";
import { snippetTags, type Snippet } from "./snippets";
import TargetMenu from "./TargetMenu";
import TabMenu from "./TabMenu";
import TabRenameField from "./TabRenameField";
import TerminalContextMenu from "./TerminalContextMenu";
import TerminalTabPanel, { SplitIcon } from "./TerminalTabPanel";
import { terminalStore } from "./terminalStore";
import type { AppSettings, RightPanel, SavedHost, SessionState, SplitDirection, SplitTarget } from "./terminalTypes";
import { themeModeCycle, themeModeLabel, useUiTheme } from "./uiTheme";
import { usePanelLayout } from "./usePanelLayout";
import { useSnippets } from "./useSnippets";
import { useUpdateCheck } from "./updates";
import { reorderKeys } from "./useListDrag";
import { useTabDrag } from "./useTabDrag";
import { useTabOverflow } from "./useTabOverflow";
import WelcomeGuide from "./WelcomeGuide";
import "./styles.css";

/** "Snippets | Files" at the top of the right-hand panel. */
function PanelSwitch({ active, snippetCount, onChange }: { active: RightPanel; snippetCount: number; onChange: (panel: RightPanel) => void }) {
  return (
    <div aria-label={t("panel.switch")} className="panel-switch" role="tablist">
      <button aria-selected={active === "snippets"} className="panel-switch-tab" onClick={() => onChange("snippets")} role="tab" type="button">
        {t("sidebar.snippets")} <span>{snippetCount}</span>
      </button>
      <button aria-selected={active === "files"} className="panel-switch-tab" onClick={() => onChange("files")} role="tab" type="button">{t("files.title")}</button>
    </div>
  );
}

export default function TabsApp() {
  const [savedHosts, setSavedHosts] = useState<SavedHost[]>([]);
  const [appSettings, setAppSettings] = useState<AppSettings>(defaultSettings);
  const settingsRef = useRef<AppSettings>(defaultSettings);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [sessionRestored, setSessionRestored] = useState(false);
  const [systemLocale, setSystemLocale] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("");

  /** Server dialog: undefined = closed, null = new server. */
  const [serverDialog, setServerDialog] = useState<SavedHost | null | undefined>(undefined);
  const [importOpen, setImportOpen] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<UploadRequest | null>(null);
  /** Files dragged over the window: which drop target is under the mouse. */
  const [dropTarget, setDropTarget] = useState<"files" | "terminal" | null>(null);
  const fileLocationRef = useRef<FileLocation | null>(null);
  /** Terminal menu "Open folder in the file browser"; the nonce makes a repeat count. */
  const [folderRequest, setFolderRequest] = useState<{ dir: string; nonce: number } | null>(null);
  const [sidebarNotice, setSidebarNotice] = useState("");
  const [serverFilters, setServerFilters] = useState<ServerFilters>({ category: null, query: "", collapsedGroups: new Set() });
  /** Snippet tag filter (lower case), null shows all. */
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [welcomeHidden, setWelcomeHidden] = useState(readWelcomeHidden);
  /** Chooser for what a new split pane runs, anchored at a button or the context menu. */
  const [splitMenu, setSplitMenu] = useState<{ direction: SplitDirection; x: number; y: number } | null>(null);
  /** "New connection" dialog from the + menu: connect without saving (or save and connect). */
  const [connectDialog, setConnectDialog] = useState<{ saveConnects: boolean; category: string } | null>(null);
  /** Chooser for a new tab (+ button or Ctrl+Shift+N): local shell or a saved server. */
  const [newTabMenu, setNewTabMenu] = useState<{ x: number; y: number } | null>(null);
  /** Settings dialog: null = closed; with an appearance id it opens on the Designs tab with that design selected. */
  const [settingsOpen, setSettingsOpen] = useState<{ appearanceId?: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  /** Right-click menu of a tab. */
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  /** Tab whose name is being edited in the tab strip. */
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  /** Number of running sessions while the close confirmation is shown. */
  const [closeConfirm, setCloseConfirm] = useState<number | null>(null);

  const usable = storageReady && !storageError;
  // Only after the settings are loaded, so a disabled check never sends a request.
  const { update, dismiss: dismissUpdate } = useUpdateCheck(storageReady && appSettings.checkUpdates, appVersion);
  const snippets = useSnippets();
  const panels = usePanelLayout({
    enabled: usable,
    zoom: appSettings.uiScale / 100,
    onPersist: (patch) => persistSettings({ ...settingsRef.current, ...patch }),
  });

  // Set synchronously during render so every t() call below (and in children) uses it.
  setLanguage(resolveLanguage(appSettings.language, systemLocale));
  useUiTheme(appSettings.themeMode, appSettings.uiScale, appSettings.uiFont, appSettings.terminalFont);

  const terminalSnapshot = useSyncExternalStore(terminalStore.subscribe, terminalStore.getSnapshot);
  const { tabs, activeTabId } = terminalSnapshot;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const canInsertSnippet = activeTab?.status === "connected";
  /** Server of the active pane, shown in the file browser. */
  const fileServer = activeTab?.kind === "ssh" ? activeTab.server : null;
  const sftpOptions = useMemo<ConnectOptions>(
    () => ({ proxy: activeProxy(appSettings), keepaliveSeconds: appSettings.keepaliveEnabled ? appSettings.keepaliveSeconds : null }),
    // Only the values matter; a new settings object with the same proxy must not reconnect.
    [appSettings.proxyEnabled, appSettings.proxyType, appSettings.proxyHost, appSettings.proxyPort, appSettings.keepaliveEnabled, appSettings.keepaliveSeconds],
  );
  const onFileLocation = useCallback((location: FileLocation | null) => { fileLocationRef.current = location; }, []);

  // Close file connections of servers that no tab shows any more.
  const openServerIds = tabs.flatMap((tab) => tab.panes).map((pane) => pane.server?.id ?? "").filter(Boolean).sort().join("\n");
  useEffect(() => {
    sftpStore.keepOnly(new Set(openServerIds.split("\n").filter(Boolean)));
  }, [openServerIds]);

  // Files dragged in from the desktop: onto the file browser or onto an SSH terminal.
  const dropRef = useRef<(paths: string[], x: number, y: number) => void>(() => undefined);
  const dragOverRef = useRef<(x: number, y: number) => void>(() => undefined);
  const dropPaneRef = useRef<HTMLElement | null>(null);
  const markDropPane = (pane: HTMLElement | null) => {
    if (dropPaneRef.current === pane) return;
    dropPaneRef.current?.classList.remove("pane-drop-target");
    pane?.classList.add("pane-drop-target");
    dropPaneRef.current = pane;
  };
  dragOverRef.current = (x, y) => {
    const element = document.elementFromPoint(x, y);
    const pane = element?.closest<HTMLElement>("[data-pane-kind='ssh']") ?? null;
    markDropPane(pane);
    setDropTarget(element?.closest(".file-panel") ? "files" : pane ? "terminal" : null);
  };
  dropRef.current = (paths, x, y) => {
    setDropTarget(null);
    markDropPane(null);
    const element = document.elementFromPoint(x, y);
    if (!paths.length || !element) return;
    const location = fileLocationRef.current;
    if (element.closest(".file-panel")) {
      if (location) void requestUpload(location, paths, false);
      return;
    }
    const pane = element.closest<HTMLElement>("[data-pane-kind='ssh']");
    if (pane?.dataset.paneId) void dropOnTerminal(pane.dataset.paneId, paths);
  };
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    // Positions come in physical pixels.
    const point = (position: { x: number; y: number }) => [position.x / window.devicePixelRatio, position.y / window.devicePixelRatio] as const;
    void getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "leave") dragOverRef.current(-1, -1);
      else if (payload.type === "drop") dropRef.current(payload.paths, ...point(payload.position));
      else dragOverRef.current(...point(payload.position));
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const tabDrag = useTabDrag(tabs, activeTabId, titleOf);
  // Changes whenever the width of the tabs can change: added, closed, moved, renamed, editing a name.
  const tabLayoutKey = `${tabs.map((tab) => `${tab.id}:${titleOf(tab)}`).join("|")}|${renamingTabId ?? ""}`;
  const tabOverflow = useTabOverflow(activeTabId, tabLayoutKey);
  const menuTab = tabMenu ? tabs.find((tab) => tab.id === tabMenu.tabId) : undefined;
  const tabName = (tabId: string | undefined) => {
    const tab = tabs.find((item) => item.id === tabId);
    return tab ? titleOf(tab) : t("terminal.pane");
  };

  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => undefined);
    void invoke<string | null>("system_locale").then(setSystemLocale).catch(() => undefined);
  }, []);

  // Load servers, settings and the last session; a first start writes both files.
  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const data = await invoke<PersistentData>("load_persistent_data");
        const servers = data.servers;
        // New installations get the starter designs, which the backend default does not contain.
        const settings = data.settingsFileExists ? data.settings : defaultSettings;
        if (!data.serversFileExists) await invoke("save_servers", { servers });
        if (!data.settingsFileExists) await invoke("save_settings", { settings });
        if (!mounted) return;

        setSavedHosts(servers);
        panels.load(settings);
        applySettings(settings);
        setStorageError("");
        if (data.recoveredFiles.length > 0) {
          setSidebarNotice(t("notice.filesRecovered", { files: data.recoveredFiles.map((file) => `${file}.broken`).join(", ") }));
        }
        if (settings.restoreTabs) restoreSession(data.session, servers);
        setSessionRestored(true);
      } catch (error) {
        if (mounted) setStorageError(t("notice.loadFailed", { error: translateBackend(error) }));
      } finally {
        if (mounted) setStorageReady(true);
      }
    })();
    return () => {
      mounted = false;
    };
    // Runs once on start; the functions used only touch state setters and the store.
  }, []);

  // Remember open tabs (local shells and server ids, nothing else) for the next start.
  const restorable = sessionTabsOf(tabs, new Set(savedHosts.map((server) => server.id)));
  const activeIndex = restorable.slice(0, tabs.findIndex((tab) => tab.id === activeTabId) + 1).filter(Boolean).length - 1;
  const sessionKey = JSON.stringify([restorable.filter(Boolean), activeIndex]);
  useEffect(() => {
    if (!sessionRestored) return;
    const [sessionTabs, activeIndex] = JSON.parse(sessionKey) as [SessionState["tabs"], number];
    const session: SessionState = appSettings.restoreTabs
      ? { tabs: sessionTabs, activeIndex: Math.max(0, activeIndex) }
      : { tabs: [], activeIndex: 0 };
    const timer = window.setTimeout(() => void invoke("save_session", { session }).catch(() => undefined), 300);
    return () => window.clearTimeout(timer);
  }, [sessionKey, sessionRestored, appSettings.restoreTabs]);

  // App shortcuts also work when no terminal has the focus (welcome guide, buttons, sidebars).
  // Terminals handle their own keys; text fields and dialogs keep theirs.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".xterm, input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu']")) return;
      if (document.querySelector("[aria-modal='true']")) return;
      terminalStore.handleGlobalKey(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Shortcuts from inside a terminal that need UI from here.
  const requestSplitRef = useRef(requestSplit);
  requestSplitRef.current = requestSplit;
  const toggleServersRef = useRef(panels.toggleServers);
  toggleServersRef.current = panels.toggleServers;
  const requestNewTabRef = useRef(requestNewTab);
  requestNewTabRef.current = requestNewTab;
  const openFolderRef = useRef<(dir: string) => void>(() => undefined);
  const showFilesRef = useRef(() => undefined as void);
  showFilesRef.current = () => {
    setRightPanel("files");
    if (!panels.showSnippets) panels.toggleSnippets();
  };
  openFolderRef.current = (dir) => {
    setFolderRequest((current) => ({ dir, nonce: (current?.nonce ?? 0) + 1 }));
    setRightPanel("files");
    if (!panels.showSnippets) panels.toggleSnippets();
  };
  useEffect(() => {
    // The menu acts on the pane it was opened in, which is then the active one.
    terminalStore.onOpenFolder((_paneId, dir) => openFolderRef.current(dir));
    // A file saved in the editor waits for "Upload": show the file browser.
    sftpStore.onAttention(() => showFilesRef.current());
    terminalStore.onSnippetShortcut(() => setPickerOpen(true));
    terminalStore.onSplitShortcut((direction, at) => requestSplitRef.current(direction, null, at));
    terminalStore.onSidebarShortcut(() => toggleServersRef.current());
    terminalStore.onNewTabShortcut(() => requestNewTabRef.current(null));
    return () => {
      terminalStore.onSnippetShortcut(null);
      terminalStore.onSplitShortcut(null);
      terminalStore.onSidebarShortcut(null);
      terminalStore.onNewTabShortcut(null);
      terminalStore.onOpenFolder(null);
      sftpStore.onAttention(null);
    };
  }, []);

  // Ask before closing the window while sessions are still running.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onCloseRequested((event) => {
      const running = runningSessionCount(terminalStore.getSnapshot().tabs);
      if (!settingsRef.current.confirmClose || running === 0) return;
      event.preventDefault();
      setCloseConfirm(running);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  async function closeWindow(dontAskAgain: boolean) {
    if (dontAskAgain) {
      const next = applySettings({ ...settingsRef.current, confirmClose: false });
      // Closing matters more than remembering the choice.
      await invoke("save_settings", { settings: next }).catch(() => undefined);
    }
    setCloseConfirm(null);
    await getCurrentWindow().destroy();
  }

  function applySettings(settings: AppSettings): AppSettings {
    const normalized = { ...settings, sidebarWidth: Math.round(settings.sidebarWidth), snippetPanelWidth: Math.round(settings.snippetPanelWidth) };
    settingsRef.current = normalized;
    setAppSettings(normalized);
    terminalStore.setClipboardPreferences(normalized);
    terminalStore.setProxy(activeProxy(normalized));
    terminalStore.setAutoReconnect(normalized.autoReconnect);
    terminalStore.setKeepalive(normalized.keepaliveEnabled ? normalized.keepaliveSeconds : null);
    terminalStore.setKeybindings(normalized.keybindings);
    terminalStore.setTerminalFont(normalized.terminalFont);
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
    // Keep the panel layout from the live settings; the dialog does not edit it.
    const live = settingsRef.current;
    const next = { ...settings, sidebarWidth: live.sidebarWidth, sidebarCollapsed: live.sidebarCollapsed, snippetPanelOpen: live.snippetPanelOpen, snippetPanelWidth: live.snippetPanelWidth, rightPanel: live.rightPanel };
    await invoke("save_settings", { settings: next });
    applySettings(next);

    // Servers pointing at a deleted design fall back to the default design.
    const knownIds = new Set(next.appearances.map((item) => item.id));
    if (savedHosts.some((server) => server.appearanceId && !knownIds.has(server.appearanceId))) {
      await storeServers(savedHosts.map((server) => server.appearanceId && !knownIds.has(server.appearanceId) ? { ...server, appearanceId: "" } : server));
    }
    setSettingsOpen(null);
  }

  /** Writes servers.json and updates open tabs; throws on failure. */
  async function storeServers(servers: SavedHost[]) {
    await invoke("save_servers", { servers });
    setSavedHosts(servers);
    terminalStore.updateServers(servers);
  }

  /**
   * "New connection" form (+ in the server list, + menu of the tabs, welcome guide): connect only,
   * save, test. From the tabs the save button also connects.
   */
  function openConnectDialog(saveConnects: boolean) {
    setSidebarNotice("");
    // A new server starts in the category that is currently filtered.
    setConnectDialog({ saveConnects, category: serverFilters.category?.trim() ?? "" });
  }

  function openServerDialog(server: SavedHost | null) {
    setSidebarNotice("");
    setServerDialog(server);
  }

  /** Adds or updates a saved server; false when writing servers.json failed. */
  async function saveServer(server: SavedHost): Promise<boolean> {
    const exists = savedHosts.some((saved) => saved.id === server.id);
    try {
      await storeServers(exists ? savedHosts.map((saved) => saved.id === server.id ? server : saved) : [...savedHosts, server]);
      setSidebarNotice(exists ? t("notice.serverUpdated") : t("notice.serverSaved"));
      setServerDialog(undefined);
      return true;
    } catch (error) {
      setStorageError(t("notice.saveServersFailed", { error: translateBackend(error) }));
      return false;
    }
  }

  /** Adds the servers picked in the ~/.ssh/config import; false when writing servers.json failed. */
  async function importServers(servers: SavedHost[]): Promise<boolean> {
    try {
      await storeServers([...savedHosts, ...servers]);
      setSidebarNotice(t("notice.serversImported", { count: servers.length }));
      return true;
    } catch (error) {
      setStorageError(t("notice.saveServersFailed", { error: translateBackend(error) }));
      return false;
    }
  }

  async function removeServer(id: string) {
    if (!usable) return;
    try {
      await storeServers(savedHosts.filter((server) => server.id !== id));
      setSidebarNotice(t("notice.serverRemoved"));
    } catch (error) {
      setStorageError(t("notice.saveServersFailed", { error: translateBackend(error) }));
    }
  }

  /** Drag and drop in the server list: new position, and the category of the group it was dropped in. */
  const moveServer: ServerListProps["onMoveServer"] = (id, target) => {
    const source = savedHosts.find((server) => server.id === id);
    if (!source || !usable) return;
    const rest = savedHosts.filter((server) => server.id !== id);
    let category: string;
    let index: number;
    if ("category" in target) {
      // Dropped on a group heading: at the end of that group.
      category = target.category;
      index = rest.length;
      for (let position = rest.length - 1; position >= 0; position -= 1) {
        if (rest[position].category === category) {
          index = position + 1;
          break;
        }
      }
    } else {
      const reference = rest.find((server) => server.id === target.serverId);
      if (!reference) return;
      category = reference.category;
      index = rest.indexOf(reference) + (target.after ? 1 : 0);
    }
    const next = [...rest.slice(0, index), { ...source, category }, ...rest.slice(index)];
    storeServers(next).catch((error: unknown) => setStorageError(t("notice.saveServersFailed", { error: translateBackend(error) })));
  };

  function reorderCategory(source: string, target: string, after: boolean) {
    const keys = serverCategories(savedHosts, settingsRef.current.categoryOrder);
    persistSettings({ ...settingsRef.current, categoryOrder: reorderKeys(keys, source, target, after) });
  }

  function reorderTag(source: string, target: string, after: boolean) {
    const keys = snippetTags(snippets.snippets, settingsRef.current.tagOrder).map((tag) => tag.key);
    persistSettings({ ...settingsRef.current, tagOrder: reorderKeys(keys, source, target, after) });
  }

  function openServer(server: SavedHost) {
    if (usable) terminalStore.openServer(server);
  }

  /** Already split: change the direction. Otherwise ask what the new pane should run. */
  function requestSplit(direction: SplitDirection, anchor: DOMRect | null, at: { x: number; y: number } | null = null) {
    if (!activeTab) return;
    if (activeTab.panes.length > 1) {
      terminalStore.setSplitDirection(activeTab.id, direction);
      return;
    }
    const x = anchor ? anchor.right - 260 : at?.x ?? window.innerWidth / 2;
    const y = anchor ? anchor.bottom + 6 : at?.y ?? window.innerHeight / 3;
    setSplitMenu({ direction, x, y });
  }

  function chooseSplit(target: SplitTarget) {
    if (!splitMenu) return;
    setSplitMenu(null);
    terminalStore.splitActiveTab(splitMenu.direction, target);
  }

  function closeSplitMenu() {
    setSplitMenu(null);
    terminalStore.focusActiveTerminal();
  }

  /** + button / shortcut: local shell, a new connection or a saved server. */
  function requestNewTab(anchor: DOMRect | null) {
    setNewTabMenu(anchor ? { x: anchor.left, y: anchor.bottom + 4 } : { x: window.innerWidth / 2 - 130, y: window.innerHeight / 3 });
  }

  function chooseNewTab(target: SplitTarget) {
    setNewTabMenu(null);
    if (target.kind === "server") terminalStore.openServer(target.server);
    else terminalStore.openLocalShell();
  }

  function closeNewTabMenu() {
    setNewTabMenu(null);
    terminalStore.focusActiveTerminal();
  }

  function insertSnippet(snippet: Snippet, execute: boolean) {
    setPickerOpen(false);
    terminalStore.insertSnippet(snippet.text, execute);
  }

  function closePicker() {
    setPickerOpen(false);
    terminalStore.focusActiveTerminal();
  }

  function showSnippetPanel() {
    setRightPanel("snippets");
    if (!panels.showSnippets) panels.toggleSnippets();
  }

  function setRightPanel(panel: RightPanel) {
    if (settingsRef.current.rightPanel !== panel) persistSettings({ ...settingsRef.current, rightPanel: panel });
  }

  /** {} in the tab bar: shows the snippets, or hides the panel when it already shows them. */
  function toggleSnippetPanel() {
    if (panels.showSnippets && settingsRef.current.rightPanel === "snippets") return panels.toggleSnippets();
    setRightPanel("snippets");
    if (!panels.showSnippets) panels.toggleSnippets();
  }

  /** 📁 in the tab bar: shows the file browser, or hides the panel when it already shows it. */
  function toggleFilePanel() {
    if (panels.showSnippets && settingsRef.current.rightPanel === "files") return panels.toggleSnippets();
    setRightPanel("files");
    if (!panels.showSnippets) panels.toggleSnippets();
  }

  /**
   * Upload into the file browser's folder: straight away, unless files would be replaced.
   * Dropped onto a terminal: always ask, the target folder can still be changed.
   */
  async function requestUpload(location: FileLocation, localPaths: string[], editable: boolean) {
    const serverName = location.server.label || serverAddress(location.server);
    const request: UploadRequest = { connection: location.connection, serverName, localPaths, dir: location.dir, editable };
    if (!editable) {
      const existing = await sftpApi.existing(location.connection, localPaths.map((path) => joinRemote(location.dir, localFileName(path)))).catch(() => []);
      if (existing.length === 0) return void startUpload(request, location.dir);
    }
    setPendingUpload(request);
  }

  function startUpload(request: UploadRequest, dir: string) {
    setPendingUpload(null);
    // Show the transfer (and, after the drop on a terminal, where it went).
    setRightPanel("files");
    if (!panels.showSnippets) panels.toggleSnippets();
    sftpStore.upload(request.connection, request.serverName, request.localPaths, dir).catch((error: unknown) => {
      setSidebarNotice(translateBackend(error));
    });
  }

  /** Files dropped onto an SSH terminal: upload to that pane's server, asking for the folder. */
  async function dropOnTerminal(paneId: string, localPaths: string[]) {
    const pane = tabs.flatMap((tab) => tab.panes).find((item) => item.id === paneId);
    const server = pane?.kind === "ssh" ? pane.server : null;
    if (!server) return;
    try {
      const connection = await sftpStore.connect(server, sftpOptions);
      await requestUpload({ connection, server, dir: sftpStore.lastDir(server.id) ?? connection.home }, localPaths, true);
    } catch (error) {
      terminalStore.showNotice(paneId, translateBackend(error));
    }
  }

  function cycleThemeMode() {
    const next = themeModeCycle[(themeModeCycle.indexOf(appSettings.themeMode) + 1) % themeModeCycle.length];
    persistSettings({ ...settingsRef.current, themeMode: next });
  }

  function setWelcome(hidden: boolean) {
    writeWelcomeHidden(hidden);
    setWelcomeHidden(hidden);
  }

  const serverDialogProps = {
    onEditDesigns: (appearanceId: string) => setSettingsOpen({ appearanceId: appearanceId || appSettings.defaultAppearanceId }),
    servers: savedHosts,
    settings: appSettings,
    storageError,
  };

  const themeIcon = appSettings.themeMode === "system" ? "◐" : appSettings.themeMode === "light" ? "☀" : "☾";
  const serversLabel = withShortcut(panels.showServers ? t("sidebar.hide") : t("sidebar.show"), terminalStore.shortcutLabel("toggleSidebar"));
  const newTabLabel = [withShortcut(t("tabs.newTab"), terminalStore.shortcutLabel("newTab")), withShortcut(t("tabs.openLocalTitle"), terminalStore.shortcutLabel("localShell"))].join("\n");
  const snippetsLabel = panels.showSnippets ? t("snippetPanel.hide") : t("snippetPanel.show");

  return (
    <div className={panels.shellClassName} style={panels.shellStyle}>
      {panels.showServers && (
        <>
          <ServerSidebar
            version={appVersion}
            doubleClick={appSettings.serverOpenClick === "double"}
            filters={serverFilters}
            notice={sidebarNotice}
            onAdd={() => openConnectDialog(false)}
            onEdit={openServerDialog}
            onImport={() => { setSidebarNotice(""); setImportOpen(true); }}
            onFilters={setServerFilters}
            onHide={panels.toggleServers}
            // Only servers with their own design get a bar, in the design's tab color.
            categoryOrder={appSettings.categoryOrder}
            onMoveServer={moveServer}
            onReorderCategory={reorderCategory}
            markerColor={(server) => { const design = appSettings.appearances.find((item) => item.id === server.appearanceId); return design && !design.hideTabColor ? design.tabColor : ""; }}
            onOpen={openServer}
            onRemove={removeServer}
            servers={savedHosts}
            storageError={storageError}
            storageReady={storageReady}
          />
          <div {...panels.resizerProps("servers")} />
          <button aria-label={t("sidebar.close")} className="sidebar-backdrop" onClick={panels.toggleServers} tabIndex={-1} type="button" />
        </>
      )}

      <main className="workspace">
        <div className="tabbar">
          <button aria-controls="server-sidebar" aria-label={serversLabel} aria-pressed={panels.showServers} className="tabbar-button" disabled={!usable} onClick={panels.toggleServers} title={serversLabel} type="button"><span aria-hidden="true">☰</span></button>
          {(tabOverflow.overflow.left > 0 || tabOverflow.overflow.right > 0) && (
            <button aria-label={t("tabs.scrollLeft", { count: tabOverflow.overflow.left })} className="tabbar-button tab-scroll-button" disabled={tabOverflow.overflow.left === 0} onClick={() => tabOverflow.scrollToHidden("left")} title={t("tabs.scrollLeft", { count: tabOverflow.overflow.left })} type="button">
              <span aria-hidden="true">‹</span>{tabOverflow.overflow.left > 0 && <span className="tab-scroll-count">{tabOverflow.overflow.left}</span>}
            </button>
          )}
          <div aria-label={t("tabs.label")} className="terminal-tabs" ref={tabOverflow.stripRef} role="tablist">
            {tabs.map((tab) => (
              <div className={`terminal-tab${tab.id === activeTabId ? " terminal-tab-active" : ""}${tab.id === tabDrag.draggingTabId ? " terminal-tab-dragging" : ""}`} data-tab-id={tab.id} key={tab.id} onContextMenu={(event) => { event.preventDefault(); setTabMenu({ tabId: tab.id, x: event.clientX, y: event.clientY }); }} style={{ "--tab-color": tabColorOf(tab), "--terminal-bg": tab.appearance.background, "--terminal-fg": tab.appearance.foreground } as CSSProperties}>
                {renamingTabId === tab.id ? (
                  <TabRenameField
                    onDone={(title) => {
                      setRenamingTabId(null);
                      if (title !== null) terminalStore.renameTab(tab.id, title);
                      terminalStore.focusActiveTerminal();
                    }}
                    placeholder={automaticTitleOf(tab)}
                    value={tab.customTitle}
                  />
                ) : (
                  <button aria-selected={tab.id === activeTabId} className="terminal-tab-select" onClick={() => terminalStore.activateTab(tab.id)} onDoubleClick={() => setRenamingTabId(tab.id)} role="tab" title={`${titleOf(tab)} · ${statusLabel(tab.status)}\n${t("tabs.renameHint")}, ${t("drag.hint")}`} type="button" {...tabDrag.tabHandlers(tab.id)}>
                    <span className={`tab-status-dot status-${tab.status}`} />
                    {tab.broadcast && <span aria-label={t("broadcast.badge", { count: tab.panes.length })} className="tab-broadcast-mark" title={t("broadcast.badge", { count: tab.panes.length })}>⇶</span>}
                    <span className="terminal-tab-title">{titleOf(tab)}</span>
                  </button>
                )}
                <button aria-label={t("tabs.close", { name: titleOf(tab) })} className="terminal-tab-close" onClick={() => void terminalStore.closeTab(tab.id)} title={withShortcut(t("tabs.closeTitle"), terminalStore.shortcutLabel("close"))} type="button">×</button>
              </div>
            ))}
          </div>
          {(tabOverflow.overflow.left > 0 || tabOverflow.overflow.right > 0) && (
            <button aria-label={t("tabs.scrollRight", { count: tabOverflow.overflow.right })} className="tabbar-button tab-scroll-button" disabled={tabOverflow.overflow.right === 0} onClick={() => tabOverflow.scrollToHidden("right")} title={t("tabs.scrollRight", { count: tabOverflow.overflow.right })} type="button">
              {tabOverflow.overflow.right > 0 && <span className="tab-scroll-count">{tabOverflow.overflow.right}</span>}<span aria-hidden="true">›</span>
            </button>
          )}
          <button aria-haspopup="menu" aria-label={t("tabs.newTab")} className="tabbar-button add-tab-button" onClick={(event) => requestNewTab(event.currentTarget.getBoundingClientRect())} title={newTabLabel} type="button"><span aria-hidden="true">+</span></button>
          <div className="tabbar-actions">
            {activeTab && (["row", "column"] as const).map((direction) => {
              // Already split: the buttons switch the layout instead of adding a pane.
              const label = activeTab.panes.length > 1
                ? t(direction === "row" ? "menu.layoutRow" : "menu.layoutColumn")
                : withShortcut(t(direction === "row" ? "menu.splitRow" : "menu.splitColumn"), terminalStore.shortcutLabel(direction === "row" ? "splitRight" : "splitDown"));
              return (
                <button aria-label={label} aria-pressed={activeTab.panes.length > 1 && activeTab.split === direction} className="tabbar-button" key={direction} onClick={(event) => requestSplit(direction, event.currentTarget.getBoundingClientRect())} title={label} type="button">
                  <SplitIcon direction={direction} />
                </button>
              );
            })}
            <button aria-label={t("topbar.themeToggle", { mode: themeModeLabel(appSettings.themeMode) })} className="tabbar-button" disabled={!usable} onClick={cycleThemeMode} title={t("topbar.themeTitle", { mode: themeModeLabel(appSettings.themeMode) })} type="button"><span aria-hidden="true">{themeIcon}</span></button>
            <button aria-label={update ? t("update.available", { version: update.version }) : t("about.open")} className={`tabbar-button${update ? " tabbar-button-badge" : ""}`} onClick={() => setAboutOpen(true)} title={update ? `${t("about.open")} · ${t("update.available", { version: update.version })}` : t("about.open")} type="button"><span aria-hidden="true">ⓘ</span></button>
            <button aria-label={t("topbar.openSettings")} className="tabbar-button" disabled={!usable} onClick={() => setSettingsOpen({})} title={t("topbar.settings")} type="button"><span aria-hidden="true">⚙</span></button>
            {/* The snippet panel opens on the right, so its toggle sits at the far right. */}
            <span aria-hidden="true" className="tabbar-separator" />
            <button aria-controls="snippet-panel" aria-label={snippetsLabel} aria-pressed={panels.showSnippets && appSettings.rightPanel === "snippets"} className="tabbar-button" disabled={!usable} onClick={toggleSnippetPanel} title={snippetsLabel} type="button"><span aria-hidden="true">{"{}"}</span></button>
            <button aria-controls="snippet-panel" aria-label={t("files.toggle")} aria-pressed={panels.showSnippets && appSettings.rightPanel === "files"} className="tabbar-button" disabled={!usable} onClick={toggleFilePanel} title={t("files.toggle")} type="button"><span aria-hidden="true">📁</span></button>
          </div>
        </div>

        <div className={`terminal-panels${tabs.length === 0 ? " terminal-panels-empty" : ""}`}>
          {tabs.length > 0 ? tabs.map((tab) => (
            <TerminalTabPanel active={tab.id === activeTabId} key={tab.id} tab={tab} />
          )) : welcomeHidden ? (
            <div className="terminal-empty">
              <span>{t("tabs.empty")}<br /><button className="text-action" onClick={() => setWelcome(false)} type="button">{t("welcome.show")}</button></span>
            </div>
          ) : (
            <div className="terminal-empty terminal-empty-guide">
              <WelcomeGuide
                doubleClick={appSettings.serverOpenClick === "double"}
                checkUpdates={appSettings.checkUpdates}
                hasServers={savedHosts.length > 0}
                onUpdateChoice={(enabled) => persistSettings({ ...settingsRef.current, checkUpdates: enabled, updatesAsked: true })}
                updatesAsked={appSettings.updatesAsked}
                onAddServer={() => openConnectDialog(false)}
                onHide={() => setWelcome(true)}
                onLocalShell={() => terminalStore.openLocalShell()}
                onSettings={() => setSettingsOpen({})}
                onSnippets={showSnippetPanel}
              />
            </div>
          )}
        </div>

      </main>

      {panels.showSnippets && appSettings.rightPanel === "files" && (
        <>
          <div {...panels.resizerProps("snippets")} />
          <FilePanel
            dropActive={dropTarget === "files"}
            editor={appSettings.editor}
            follow={appSettings.filesFollowTerminal}
            onFollow={(follow) => persistSettings({ ...settingsRef.current, filesFollowTerminal: follow })}
            openRequest={folderRequest}
            terminalDir={activeTab?.kind === "ssh" ? activeTab.panes.find((pane) => pane.id === activeTab.activePaneId)?.cwd ?? "" : ""}
            onCd={(command) => { terminalStore.insertSnippet(command, false); terminalStore.focusActiveTerminal(); }}
            onHide={panels.toggleSnippets}
            onLocation={onFileLocation}
            onUpload={(location, paths) => void requestUpload(location, paths, false)}
            options={sftpOptions}
            panelSwitch={<PanelSwitch active="files" onChange={setRightPanel} snippetCount={snippets.snippets.length} />}
            server={fileServer}
          />
          <button aria-label={t("snippetPanel.hide")} className="sidebar-backdrop snippet-panel-backdrop" onClick={panels.toggleSnippets} tabIndex={-1} type="button" />
        </>
      )}
      {panels.showSnippets && appSettings.rightPanel === "snippets" && (
        <>
          <div {...panels.resizerProps("snippets")} />
          <SnippetPanel
            panelSwitch={<PanelSwitch active="snippets" onChange={setRightPanel} snippetCount={snippets.snippets.length} />}
            canInsert={canInsertSnippet}
            doubleClick={appSettings.snippetInsertClick === "double"}
            error={snippets.error}
            notice={snippets.notice}
            onAdd={() => snippets.edit({ id: "", name: "", text: "", tags: [] })}
            onDelete={snippets.remove}
            onDuplicate={snippets.duplicate}
            onEdit={snippets.edit}
            onHide={panels.toggleSnippets}
            onInsert={insertSnippet}
            onMove={snippets.move}
            onReorderTag={reorderTag}
            tagOrder={appSettings.tagOrder}
            onOpenPicker={() => setPickerOpen(true)}
            onTagFilter={setTagFilter}
            ready={snippets.ready}
            snippets={snippets.snippets}
            tagFilter={tagFilter}
          />
          <button aria-label={t("snippetPanel.hide")} className="sidebar-backdrop snippet-panel-backdrop" onClick={panels.toggleSnippets} tabIndex={-1} type="button" />
        </>
      )}

      {terminalSnapshot.pendingPaste && (
        <PasteConfirmDialog
          onCancel={() => terminalStore.cancelPendingPaste()}
          onConfirm={(remember) => {
            // "Never ask" switches off Settings → Confirm multiline paste.
            if (remember === "never") persistSettings({ ...settingsRef.current, confirmMultilinePaste: false });
            terminalStore.confirmPendingPaste(remember === "session");
          }}
          paste={terminalSnapshot.pendingPaste}
          targetName={tabName(terminalSnapshot.pendingPaste.tabId)}
        />
      )}
      {serverDialog !== undefined && (
        <ServerDialog
          initialCategory={serverFilters.category?.trim() ?? ""}
          onClose={() => setServerDialog(undefined)}
          onSave={async (server) => { await saveServer(server); }}
          server={serverDialog}
          {...serverDialogProps}
        />
      )}
      {pendingUpload && (
        <UploadDialog
          onCancel={() => setPendingUpload(null)}
          onConfirm={(dir) => startUpload(pendingUpload, dir)}
          request={pendingUpload}
        />
      )}
      {importOpen && (
        <SshImportDialog
          initialCategory={serverFilters.category?.trim() ?? ""}
          onClose={() => setImportOpen(false)}
          onImport={importServers}
          servers={savedHosts}
        />
      )}
      {connectDialog && (
        <ServerDialog
          initialCategory={connectDialog.category}
          onClose={() => { setConnectDialog(null); terminalStore.focusActiveTerminal(); }}
          onConnect={(server) => {
            // Not saved: the tab works as usual but is not restored on the next start.
            setConnectDialog(null);
            terminalStore.openServer(server);
          }}
          onSave={async (server) => {
            if (!(await saveServer(server))) return;
            setConnectDialog(null);
            if (connectDialog.saveConnects) terminalStore.openServer(server);
          }}
          saveConnects={connectDialog.saveConnects}
          server={null}
          {...serverDialogProps}
        />
      )}
      {terminalSnapshot.pendingClipboardRead && (
        <ClipboardReadDialog
          onAllow={() => terminalStore.answerClipboardRead("session")}
          onDeny={() => terminalStore.answerClipboardRead("deny")}
          targetName={tabName(terminalSnapshot.pendingClipboardRead.tabId)}
        />
      )}
      {closeConfirm !== null && <CloseConfirmDialog onCancel={() => setCloseConfirm(null)} onConfirm={(dontAsk) => void closeWindow(dontAsk)} running={closeConfirm} />}
      {tabDrag.overlay}
      {tabMenu && menuTab && (
        <TabMenu
          onClose={() => setTabMenu(null)}
          onCloseTab={() => { setTabMenu(null); void terminalStore.closeTab(menuTab.id); }}
          onColor={(color) => terminalStore.setTabColor(menuTab.id, color)}
          onRename={() => { setTabMenu(null); setRenamingTabId(menuTab.id); }}
          onBroadcast={() => { setTabMenu(null); terminalStore.toggleBroadcast(menuTab.id); }}
          onSession={() => {
            setTabMenu(null);
            const running = menuTab.status === "connected" || menuTab.status === "connecting";
            void (running ? terminalStore.disconnect(menuTab.id) : terminalStore.connect(menuTab.id));
          }}
          tab={menuTab}
          x={tabMenu.x}
          y={tabMenu.y}
        />
      )}
      {splitMenu && activeTab && (
        <TargetMenu
          onChoose={chooseSplit}
          onClose={closeSplitMenu}
          same={{ label: titleOf(activeTab), shortcut: terminalStore.shortcutLabel(splitMenu.direction === "row" ? "splitRight" : "splitDown") }}
          serverAddress={serverAddress}
          servers={savedHosts}
          title={splitMenu.direction === "row" ? t("split.menuRow") : t("split.menuColumn")}
          x={splitMenu.x}
          y={splitMenu.y}
        />
      )}
      {newTabMenu && (
        <TargetMenu
          localShortcut={terminalStore.shortcutLabel("localShell")}
          onChoose={chooseNewTab}
          onClose={closeNewTabMenu}
          onNewConnection={() => { setNewTabMenu(null); openConnectDialog(true); }}
          serverAddress={serverAddress}
          servers={savedHosts}
          title={t("tabs.newTabMenu")}
          x={newTabMenu.x}
          y={newTabMenu.y}
        />
      )}
      {terminalSnapshot.contextMenu && <TerminalContextMenu key={`${terminalSnapshot.contextMenu.x},${terminalSnapshot.contextMenu.y}`} menu={terminalSnapshot.contextMenu} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} onDismissUpdate={dismissUpdate} update={update} version={appVersion} />}
      {pickerOpen && (
        <SnippetPicker
          canInsert={canInsertSnippet}
          onClose={closePicker}
          onInsert={insertSnippet}
          onManage={() => { setPickerOpen(false); showSnippetPanel(); }}
          snippets={snippets.snippets}
        />
      )}
      {snippets.editing && <SnippetEditor existingTags={snippetTags(snippets.snippets, appSettings.tagOrder)} onClose={snippets.closeEditor} onSave={snippets.store} snippet={snippets.editing} />}
      {/* Rendered last so it stacks above the server dialog when opened from there. */}
      {settingsOpen && (
        <SettingsDialog initialAppearanceId={settingsOpen.appearanceId} onClose={() => setSettingsOpen(null)} onSave={saveSettingsDialog} servers={savedHosts} settings={appSettings} systemLocale={systemLocale} />
      )}
    </div>
  );
}

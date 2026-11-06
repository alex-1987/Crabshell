import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import AboutDialog from "./AboutDialog";
import { defaultSettings } from "./appearance";
import { ClipboardReadDialog, CloseConfirmDialog, PasteConfirmDialog } from "./ConfirmDialogs";
import { resolveLanguage, setLanguage, t, translateBackend } from "./i18n";
import { automaticTitleOf, runningSessionCount, serverAddress, statusLabel, tabColorOf, titleOf } from "./labels";
import { clearLegacyStorage, loadLegacyServers, loadLegacySettings, readWelcomeHidden, restoreSession, sessionTabsOf, writeWelcomeHidden, type PersistentData } from "./persistence";
import ServerDialog from "./ServerDialog";
import ServerSidebar, { type ServerFilters } from "./ServerSidebar";
import SettingsDialog from "./SettingsDialog";
import SnippetEditor from "./SnippetEditor";
import SnippetPanel from "./SnippetPanel";
import SnippetPicker from "./SnippetPicker";
import type { Snippet } from "./snippets";
import SplitMenu from "./SplitMenu";
import TabMenu from "./TabMenu";
import TabRenameField from "./TabRenameField";
import TerminalContextMenu from "./TerminalContextMenu";
import TerminalTabPanel from "./TerminalTabPanel";
import { terminalStore } from "./terminalStore";
import type { AppSettings, SavedHost, SessionState, SplitDirection, SplitTarget } from "./terminalTypes";
import { themeModeCycle, themeModeLabel, useUiTheme } from "./uiTheme";
import { usePanelLayout } from "./usePanelLayout";
import { useSnippets } from "./useSnippets";
import { useTabDrag } from "./useTabDrag";
import WelcomeGuide from "./WelcomeGuide";
import "./styles.css";

/** Shortcut summary in the footer, built from the current key bindings. */
function footerShortcuts(): string {
  const key = terminalStore.shortcutLabel.bind(terminalStore);
  return [
    [key("copy"), key("paste"), t("footer.copyPaste")],
    [key("snippets"), t("footer.snippets")],
    [key("localShell"), t("footer.localShell")],
    [key("splitRight"), key("splitDown"), t("footer.split")],
    [key("close"), t("footer.close")],
  ].map((parts) => {
    const label = parts.pop() ?? "";
    const keys = parts.filter(Boolean).join(" / ");
    return keys ? `${keys} ${label}` : "";
  }).filter(Boolean).join(" · ");
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
  const [sidebarNotice, setSidebarNotice] = useState("");
  const [serverFilters, setServerFilters] = useState<ServerFilters>({ category: null, query: "", collapsedGroups: new Set() });
  /** Snippet tag filter (lower case), null shows all. */
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [welcomeHidden, setWelcomeHidden] = useState(readWelcomeHidden);
  /** Chooser for what a new split pane runs, anchored at a button or the context menu. */
  const [splitMenu, setSplitMenu] = useState<{ direction: SplitDirection; x: number; y: number } | null>(null);
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
  const snippets = useSnippets();
  const panels = usePanelLayout({
    enabled: usable,
    zoom: appSettings.uiScale / 100,
    onPersist: (patch) => persistSettings({ ...settingsRef.current, ...patch }),
  });

  // Set synchronously during render so every t() call below (and in children) uses it.
  setLanguage(resolveLanguage(appSettings.language, systemLocale));
  useUiTheme(appSettings.themeMode, appSettings.uiScale);

  const terminalSnapshot = useSyncExternalStore(terminalStore.subscribe, terminalStore.getSnapshot);
  const { tabs, activeTabId } = terminalSnapshot;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const canInsertSnippet = activeTab?.status === "connected";
  const tabDrag = useTabDrag(tabs, activeTabId, titleOf);
  const menuTab = tabMenu ? tabs.find((tab) => tab.id === tabMenu.tabId) : undefined;
  const tabName = (tabId: string | undefined) => {
    const tab = tabs.find((item) => item.id === tabId);
    return tab ? titleOf(tab) : t("terminal.pane");
  };

  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => undefined);
    void invoke<string | null>("system_locale").then(setSystemLocale).catch(() => undefined);
  }, []);

  // Load servers, settings and the last session; migrate data from old localStorage versions.
  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const data = await invoke<PersistentData>("load_persistent_data");
        const servers = data.serversFileExists ? data.servers : loadLegacyServers();
        const settings = data.settingsFileExists ? data.settings : loadLegacySettings();
        if (!data.serversFileExists) await invoke("save_servers", { servers });
        if (!data.settingsFileExists) await invoke("save_settings", { settings });
        if (!mounted) return;

        setSavedHosts(servers);
        panels.load(settings);
        applySettings(settings);
        clearLegacyStorage();
        setStorageError("");
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
  const sessionKey = JSON.stringify([sessionTabsOf(tabs), tabs.findIndex((tab) => tab.id === activeTabId)]);
  useEffect(() => {
    if (!sessionRestored) return;
    const [sessionTabs, activeIndex] = JSON.parse(sessionKey) as [SessionState["tabs"], number];
    const session: SessionState = appSettings.restoreTabs
      ? { tabs: sessionTabs.filter((tab) => tab.kind === "local" || tab.serverId), activeIndex: Math.max(0, activeIndex) }
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
  useEffect(() => {
    terminalStore.onSnippetShortcut(() => setPickerOpen(true));
    terminalStore.onSplitShortcut((direction, at) => requestSplitRef.current(direction, null, at));
    return () => {
      terminalStore.onSnippetShortcut(null);
      terminalStore.onSplitShortcut(null);
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
    // Keep the panel layout from the live settings; the dialog does not edit it.
    const live = settingsRef.current;
    const next = { ...settings, sidebarWidth: live.sidebarWidth, sidebarCollapsed: live.sidebarCollapsed, snippetPanelOpen: live.snippetPanelOpen, snippetPanelWidth: live.snippetPanelWidth };
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

  function openServerDialog(server: SavedHost | null) {
    setSidebarNotice("");
    setServerDialog(server);
  }

  async function saveServer(server: SavedHost) {
    const exists = savedHosts.some((saved) => saved.id === server.id);
    try {
      await storeServers(exists ? savedHosts.map((saved) => saved.id === server.id ? server : saved) : [...savedHosts, server]);
      setSidebarNotice(exists ? t("notice.serverUpdated") : t("notice.serverSaved"));
      setServerDialog(undefined);
    } catch (error) {
      setStorageError(t("notice.saveServersFailed", { error: translateBackend(error) }));
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

  function insertSnippet(snippet: Snippet, execute: boolean) {
    setPickerOpen(false);
    terminalStore.insertSnippet(snippet.text, execute);
  }

  function closePicker() {
    setPickerOpen(false);
    terminalStore.focusActiveTerminal();
  }

  function showSnippetPanel() {
    if (!panels.showSnippets) panels.toggleSnippets();
  }

  function cycleThemeMode() {
    const next = themeModeCycle[(themeModeCycle.indexOf(appSettings.themeMode) + 1) % themeModeCycle.length];
    persistSettings({ ...settingsRef.current, themeMode: next });
  }

  function setWelcome(hidden: boolean) {
    writeWelcomeHidden(hidden);
    setWelcomeHidden(hidden);
  }

  const themeIcon = appSettings.themeMode === "system" ? "◐" : appSettings.themeMode === "light" ? "☀" : "☾";
  const serversLabel = panels.showServers ? t("sidebar.hide") : t("sidebar.show");
  const snippetsLabel = panels.showSnippets ? t("snippetPanel.hide") : t("snippetPanel.show");

  return (
    <div className={panels.shellClassName} style={panels.shellStyle}>
      {panels.showServers && (
        <>
          <ServerSidebar
            doubleClick={appSettings.serverOpenClick === "double"}
            filters={serverFilters}
            notice={sidebarNotice}
            onAdd={() => openServerDialog(null)}
            onEdit={openServerDialog}
            onFilters={setServerFilters}
            onHide={panels.toggleServers}
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
        <header className="topbar">
          <div className="topbar-left">
            <button aria-controls="server-sidebar" aria-label={serversLabel} aria-pressed={panels.showServers} className="panel-toggle" disabled={!usable} onClick={panels.toggleServers} title={serversLabel} type="button"><span aria-hidden="true">☰</span><span className="panel-toggle-label">{t("sidebar.servers")}</span></button>
            <div className="breadcrumb"><span>CRABSHELL</span><i>/</i><strong>{t("topbar.terminal")}</strong></div>
          </div>
          <div className="topbar-actions">
            <span className="active-host-label">{activeTab ? titleOf(activeTab) : t("topbar.noSession")}</span>
            <span className={`connection-label label-${activeTab?.status ?? "disconnected"}`}><span className="status-led" />{statusLabel(activeTab?.status ?? "disconnected")}</span>
            {activeTab && (activeTab.status === "disconnected" || activeTab.status === "failed") && (
              <button className="connect-button" onClick={() => void terminalStore.connect(activeTab.id)} type="button">{activeTab.kind === "local" ? t("topbar.restart") : t("topbar.reconnect")} <span aria-hidden="true">↻</span></button>
            )}
            <button className="disconnect-button" disabled={!activeTab || (activeTab.status !== "connected" && activeTab.status !== "connecting")} onClick={() => activeTab && void terminalStore.disconnect(activeTab.id)} type="button"><span aria-hidden="true">■</span> {activeTab?.kind === "local" ? t("topbar.stop") : t("topbar.disconnect")}</button>
            <button aria-controls="snippet-panel" aria-label={snippetsLabel} aria-pressed={panels.showSnippets} className="panel-toggle" disabled={!usable} onClick={panels.toggleSnippets} title={snippetsLabel} type="button"><span aria-hidden="true">{"{}"}</span><span className="panel-toggle-label">{t("sidebar.snippets")}</span></button>
            <button aria-label={t("topbar.themeToggle", { mode: themeModeLabel(appSettings.themeMode) })} className="icon-button settings-button theme-toggle" disabled={!usable} onClick={cycleThemeMode} title={t("topbar.themeTitle", { mode: themeModeLabel(appSettings.themeMode) })} type="button"><span aria-hidden="true">{themeIcon}</span></button>
            <button aria-label={t("about.open")} className="icon-button settings-button" onClick={() => setAboutOpen(true)} title={t("about.open")} type="button"><span aria-hidden="true">ⓘ</span></button>
            <button aria-label={t("topbar.openSettings")} className="icon-button settings-button" disabled={!usable} onClick={() => setSettingsOpen({})} title={t("topbar.settings")} type="button"><span aria-hidden="true">⚙</span></button>
          </div>
        </header>

        <div aria-label={t("tabs.label")} className="terminal-tabs" role="tablist">
          {tabs.map((tab) => (
            <div className={`terminal-tab${tab.id === activeTabId ? " terminal-tab-active" : ""}${tab.id === tabDrag.draggingTabId ? " terminal-tab-dragging" : ""}`} data-tab-id={tab.id} key={tab.id} onContextMenu={(event) => { event.preventDefault(); setTabMenu({ tabId: tab.id, x: event.clientX, y: event.clientY }); }} style={{ "--tab-color": tabColorOf(tab) } as CSSProperties}>
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
                <button aria-selected={tab.id === activeTabId} className="terminal-tab-select" onClick={() => terminalStore.activateTab(tab.id)} onDoubleClick={() => setRenamingTabId(tab.id)} role="tab" title={`${titleOf(tab)} · ${t("tabs.renameHint")}, ${t("drag.hint")}`} type="button" {...tabDrag.tabHandlers(tab.id)}>
                  <span className={`tab-status-dot status-${tab.status}`} />
                  {tab.kind === "local" && <span aria-label={t("tabs.local")} className="tab-kind-local">&gt;_</span>}
                  <span className="terminal-tab-title">{titleOf(tab)}</span>
                </button>
              )}
              <button aria-label={t("tabs.close", { name: titleOf(tab) })} className="terminal-tab-close" onClick={() => void terminalStore.closeTab(tab.id)} title={t("tabs.closeTitle")} type="button">×</button>
            </div>
          ))}
          <button aria-label={t("tabs.openLocal")} className="icon-button add-tab-button" onClick={() => terminalStore.openLocalShell()} title={t("tabs.openLocalTitle")} type="button"><span aria-hidden="true">+</span></button>
        </div>

        <div className={`terminal-panels${tabs.length === 0 ? " terminal-panels-empty" : ""}`}>
          {tabs.length > 0 ? tabs.map((tab) => (
            <TerminalTabPanel active={tab.id === activeTabId} key={tab.id} onSplit={(direction, anchor) => requestSplit(direction, anchor)} tab={tab} />
          )) : welcomeHidden ? (
            <div className="terminal-empty">
              <span>{t("tabs.empty")}<br /><button className="text-action" onClick={() => setWelcome(false)} type="button">{t("welcome.show")}</button></span>
            </div>
          ) : (
            <div className="terminal-empty terminal-empty-guide">
              <WelcomeGuide
                doubleClick={appSettings.serverOpenClick === "double"}
                hasServers={savedHosts.length > 0}
                onAddServer={() => openServerDialog(null)}
                onHide={() => setWelcome(true)}
                onLocalShell={() => terminalStore.openLocalShell()}
                onSettings={() => setSettingsOpen({})}
                onSnippets={showSnippetPanel}
              />
            </div>
          )}
        </div>

        <footer className="workspace-footer">
          <span>Crabshell <b>{appVersion}</b></span>
          <span>{footerShortcuts()}</span>
        </footer>
      </main>

      {panels.showSnippets && (
        <>
          <div {...panels.resizerProps("snippets")} />
          <SnippetPanel
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
          onConfirm={() => terminalStore.confirmPendingPaste()}
          paste={terminalSnapshot.pendingPaste}
          targetName={tabName(terminalSnapshot.pendingPaste.tabId)}
        />
      )}
      {serverDialog !== undefined && (
        <ServerDialog
          initialCategory={serverFilters.category?.trim() ?? ""}
          onClose={() => setServerDialog(undefined)}
          onEditDesigns={(appearanceId) => setSettingsOpen({ appearanceId: appearanceId || appSettings.defaultAppearanceId })}
          onSave={saveServer}
          server={serverDialog}
          servers={savedHosts}
          settings={appSettings}
          storageError={storageError}
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
          tab={menuTab}
          x={tabMenu.x}
          y={tabMenu.y}
        />
      )}
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
        <SnippetPicker
          canInsert={canInsertSnippet}
          onClose={closePicker}
          onInsert={insertSnippet}
          onManage={() => { setPickerOpen(false); showSnippetPanel(); }}
          snippets={snippets.snippets}
        />
      )}
      {snippets.editing && <SnippetEditor onClose={snippets.closeEditor} onSave={snippets.store} snippet={snippets.editing} />}
      {/* Rendered last so it stacks above the server dialog when opened from there. */}
      {settingsOpen && (
        <SettingsDialog initialAppearanceId={settingsOpen.appearanceId} onClose={() => setSettingsOpen(null)} onSave={saveSettingsDialog} servers={savedHosts} settings={appSettings} systemLocale={systemLocale} />
      )}
    </div>
  );
}

import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { defaultSettings } from "./appearance";
import SettingsDialog from "./SettingsDialog";
import TerminalPane from "./TerminalPane";
import { resolveLanguage, setLanguage, t, translateBackend } from "./i18n";
import { themeModeCycle, themeModeLabel, useUiTheme } from "./uiTheme";
import { terminalStore } from "./terminalStore";
import type { AppSettings, SavedHost, SessionStatus, TerminalTab } from "./terminalTypes";
import "./styles.css";

const HOSTS_STORAGE_KEY = "crabshell.saved-hosts.v1";
const LEGACY_HOST_STORAGE_KEY = "crabshell.saved-host.v1";
const SIDEBAR_WIDTH_KEY = "crabshell.sidebar-width.v1";
const SIDEBAR_COLLAPSED_KEY = "crabshell.sidebar-collapsed.v1";

function statusLabel(status: SessionStatus): string {
  return t(`status.${status}`);
}

function titleOf(tab: TerminalTab): string {
  return tab.kind === "local" ? t("tabs.localShell") : tab.title;
}

type PersistentData = {
  servers: SavedHost[];
  settings: AppSettings;
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
    username: typeof saved.username === "string" ? saved.username : "",
    identityFile: typeof saved.identityFile === "string" ? saved.identityFile : "",
    appearanceId: typeof saved.appearanceId === "string" ? saved.appearanceId : "",
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
  const [username, setUsername] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [appearanceId, setAppearanceId] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarNotice, setSidebarNotice] = useState("");
  const sidebarWidthRef = useRef(sidebarWidth);
  const settingsRef = useRef<AppSettings>(defaultSettings);
  const resizingSidebarRef = useRef(false);
  sidebarWidthRef.current = sidebarWidth;

  const [systemLocale, setSystemLocale] = useState<string | null>(null);
  useEffect(() => {
    void invoke<string | null>("system_locale").then(setSystemLocale).catch(() => undefined);
  }, []);
  // Set synchronously during render so every t() call below (and in children) uses it.
  setLanguage(resolveLanguage(appSettings.language, systemLocale));

  useUiTheme(appSettings.themeMode, appSettings.uiScale);

  const terminalSnapshot = useSyncExternalStore(terminalStore.subscribe, terminalStore.getSnapshot);
  const activeTab = terminalSnapshot.tabs.find((tab) => tab.id === terminalSnapshot.activeTabId) ?? null;

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
        setAppSettings(nextSettings);
        sidebarWidthRef.current = nextSettings.sidebarWidth;
        settingsRef.current = nextSettings;
        terminalStore.setClipboardPreferences(nextSettings);
        terminalStore.setAppearances(nextSettings.appearances, nextSettings.defaultAppearanceId, nextSettings.localAppearanceId);
        localStorage.removeItem(HOSTS_STORAGE_KEY);
        localStorage.removeItem(LEGACY_HOST_STORAGE_KEY);
        localStorage.removeItem(SIDEBAR_WIDTH_KEY);
        localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
        setStorageError("");
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
    setUsername(server?.username ?? "");
    setIdentityFile(server?.identityFile ?? "");
    setAppearanceId(server?.appearanceId ?? "");
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

    const server: SavedHost = {
      id: editingId ?? crypto.randomUUID(),
      label: label.trim(),
      host: savedHost,
      username: username.trim(),
      identityFile,
      // The design may have been deleted while this dialog was open.
      appearanceId: appSettings.appearances.some((item) => item.id === appearanceId) ? appearanceId : "",
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
    const normalized = { ...settings, sidebarWidth: Math.round(settings.sidebarWidth) };
    settingsRef.current = normalized;
    setAppSettings(normalized);
    terminalStore.setClipboardPreferences(normalized);
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
    // Keep sidebar state from the live settings; the dialog does not edit it.
    const next = { ...settings, sidebarWidth: settingsRef.current.sidebarWidth, sidebarCollapsed: settingsRef.current.sidebarCollapsed };
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
    const collapsed = !sidebarCollapsed;
    setSidebarCollapsed(collapsed);
    persistSettings({ ...settingsRef.current, sidebarCollapsed: collapsed });
  }

  function setResizedSidebarWidth(width: number) {
    const nextWidth = Math.round(Math.min(420, Math.max(210, width)));
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
  }

  function handleSidebarResizeKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!storageReady || storageError || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const nextWidth = sidebarWidth + (event.key === "ArrowLeft" ? -16 : 16);
    setResizedSidebarWidth(nextWidth);
    persistSettings({ ...settingsRef.current, sidebarWidth: Math.round(nextWidth) });
  }

  const shellStyle = { "--sidebar-width": `${sidebarWidth}px` } as CSSProperties;

  return (
    <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`} style={shellStyle}>
      {!sidebarCollapsed && (
        <>
          <aside className="sidebar" id="server-sidebar">
            <div className="sidebar-brand-row">
              <div className="brand-row">
                <div className="brand-mark" aria-hidden="true"><span /></div>
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
            <nav aria-label={t("sidebar.savedServers")} className="saved-server-list">
              {!storageReady ? <div className="sidebar-empty">{t("sidebar.loading")}</div> : storageError ? <div aria-live="polite" className="sidebar-storage-error">{storageError}</div> : savedHosts.length === 0 ? <div className="sidebar-empty">{t("sidebar.empty")}</div> : savedHosts.map((server) => (
                <div className="saved-server" key={server.id}>
                  <button className="saved-server-main" disabled={!storageReady || Boolean(storageError)} onClick={() => openServer(server)} title={`${server.username ? `${server.username}@` : ""}${server.host}`} type="button">
                    <span className="saved-server-name">{server.label || server.host}</span>
                    <span className="saved-server-host">{server.username ? `${server.username}@` : ""}{server.host}</span>
                    {server.identityFile && <span className="saved-server-key">{t("sidebar.key", { file: fileName(server.identityFile) })}</span>}
                  </button>
                  {confirmDeleteId === server.id ? (
                    <div className="sidebar-delete-confirm" role="group" aria-label={t("sidebar.removeGroup", { name: server.label || server.host })}>
                      <button className="text-action" onClick={() => setConfirmDeleteId(null)} type="button">{t("common.cancel")}</button>
                      <button className="text-action text-danger" onClick={() => void removeHost(server.id)} type="button">{t("sidebar.remove")}</button>
                    </div>
                  ) : (
                    <div className="saved-server-actions">
                      <button aria-label={t("sidebar.editServer", { name: server.label || server.host })} className="icon-button row-icon-button" onClick={() => openEditor(server)} title={t("sidebar.edit")} type="button"><span aria-hidden="true">✎</span></button>
                      <button aria-label={t("sidebar.deleteServer", { name: server.label || server.host })} className="icon-button row-icon-button" onClick={() => setConfirmDeleteId(server.id)} title={t("sidebar.delete")} type="button"><span aria-hidden="true">×</span></button>
                    </div>
                  )}
                </div>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="open-ssh-badge"><span>SSH</span><div><strong>OpenSSH</strong><small>{t("sidebar.systemInstall")}</small></div></div>
              <div className="sidebar-meta">{t("sidebar.meta")}</div>
            </div>
          </aside>
          <div
            aria-controls="server-sidebar"
            aria-label={t("sidebar.resize")}
            aria-orientation="vertical"
            aria-valuemax={420}
            aria-valuemin={210}
            aria-valuenow={sidebarWidth}
            className="sidebar-resizer"
            onKeyDown={handleSidebarResizeKey}
            onLostPointerCapture={() => {
              if (resizingSidebarRef.current) {
                resizingSidebarRef.current = false;
                persistSettings({ ...settingsRef.current, sidebarWidth: sidebarWidthRef.current });
              }
            }}
            onPointerDown={(event) => {
              if (!storageReady || storageError) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              resizingSidebarRef.current = true;
              event.preventDefault();
            }}
            onPointerMove={(event) => { if (resizingSidebarRef.current) setResizedSidebarWidth(event.clientX); }}
            onPointerUp={() => {
              if (resizingSidebarRef.current) {
                resizingSidebarRef.current = false;
                persistSettings({ ...settingsRef.current, sidebarWidth: sidebarWidthRef.current });
              }
            }}
            role="separator"
            tabIndex={0}
          />
          <button aria-label={t("sidebar.close")} className="sidebar-backdrop" onClick={toggleSidebar} tabIndex={-1} type="button" />
        </>
      )}

      <main className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            {sidebarCollapsed && <button aria-label={t("sidebar.show")} className="icon-button show-sidebar-button" disabled={!storageReady} onClick={toggleSidebar} title={t("sidebar.show")} type="button"><span aria-hidden="true">☰</span></button>}
            <div className="breadcrumb"><span>CRABSHELL</span><i>/</i><strong>{t("topbar.terminal")}</strong></div>
          </div>
          <div className="topbar-actions">
            <span className="active-host-label">{activeTab ? titleOf(activeTab) : t("topbar.noSession")}</span>
            <span className={`connection-label label-${activeTab?.status ?? "disconnected"}`}><span className="status-led" />{statusLabel(activeTab?.status ?? "disconnected")}</span>
            {activeTab && (activeTab.status === "disconnected" || activeTab.status === "failed") && (
              <button className="connect-button" onClick={() => void terminalStore.connect(activeTab.id)} type="button">{activeTab.kind === "local" ? t("topbar.restart") : t("topbar.reconnect")} <span aria-hidden="true">↻</span></button>
            )}
            <button className="disconnect-button" disabled={!activeTab || (activeTab.status !== "connected" && activeTab.status !== "connecting")} onClick={() => activeTab && void terminalStore.disconnect(activeTab.id)} type="button"><span aria-hidden="true">■</span> {activeTab?.kind === "local" ? t("topbar.stop") : t("topbar.disconnect")}</button>
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
            <button aria-label={t("topbar.openSettings")} className="icon-button settings-button" disabled={!storageReady || Boolean(storageError)} onClick={() => setSettingsOpen(true)} title={t("topbar.settings")} type="button"><span aria-hidden="true">⚙</span></button>
          </div>
        </header>

        <div aria-label={t("tabs.label")} className="terminal-tabs" role="tablist">
          {terminalSnapshot.tabs.map((tab) => (
            <div className={`terminal-tab${tab.id === terminalSnapshot.activeTabId ? " terminal-tab-active" : ""}`} key={tab.id} style={{ "--tab-color": tab.appearance.tabColor } as CSSProperties}>
              <button aria-selected={tab.id === terminalSnapshot.activeTabId} className="terminal-tab-select" onClick={() => terminalStore.activateTab(tab.id)} role="tab" title={titleOf(tab)} type="button">
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
                  <div className="transport-tag"><span /> {tab.kind === "local" ? t("terminal.local") : "OPENSSH"} <b>·</b> PTY</div>
                </div>
                <div className="terminal-body" style={{ "--terminal-bg": tab.appearance.background } as CSSProperties}><TerminalPane tabId={tab.id} paneId={tab.paneTree.paneId} /></div>
                <div className="terminal-statusbar">
                  <div className="status-message"><span className={`status-led status-${tab.status}`} />{tab.notice || statusLabel(tab.status)}</div>
                  <div className="terminal-metrics">{tab.status === "connected" ? t("terminal.sessionActive") : t("terminal.localSession")}<span>UTF-8</span></div>
                </div>
              </div>
            </section>
          ))}
        </div>

        <footer className="workspace-footer">
          <span>Crabshell <b>0.1.0</b></span>
          <span>{t("footer.shortcuts")}</span>
        </footer>
      </main>

      {terminalSnapshot.pendingPaste && (() => {
        const text = terminalSnapshot.pendingPaste.text;
        const lines = text.split(/\r\n|\r|\n/);
        const lineCount = text.endsWith("\n") || text.endsWith("\r") ? lines.length - 1 : lines.length;
        const targetTab = terminalSnapshot.tabs.find((tab) => tab.id === terminalSnapshot.pendingPaste?.tabId);
        const preview = lines.slice(0, 12).join("\n") + (lines.length > 12 ? "\n…" : "");
        return (
          <div className="dialog-scrim" onKeyDown={(event) => { if (event.key === "Escape") terminalStore.cancelPendingPaste(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) terminalStore.cancelPendingPaste(); }} role="presentation">
            <section aria-labelledby="paste-title" aria-modal="true" className="server-dialog paste-dialog" role="dialog">
              <header className="dialog-heading">
                <div><div className="page-eyebrow">{t("paste.eyebrow")}</div><h2 id="paste-title">{t("paste.title")}</h2></div>
                <button aria-label={t("paste.cancelLabel")} className="icon-button" onClick={() => terminalStore.cancelPendingPaste()} type="button">×</button>
              </header>
              <div className="form-footnote">
                {t("paste.summary", { lines: lineCount, chars: text.length })} <strong>{targetTab ? titleOf(targetTab) : t("terminal.pane")}</strong>. {t("paste.warning")}
              </div>
              <pre className="paste-preview">{preview}</pre>
              <div className="editor-actions">
                <button autoFocus className="button button-secondary" onClick={() => terminalStore.cancelPendingPaste()} type="button">{t("common.cancel")}</button>
                <button className="button button-primary" onClick={() => terminalStore.confirmPendingPaste()} type="button">{t("paste.confirm")}</button>
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
              <label className="field-label" htmlFor="host">{t("server.host")}</label>
              <input autoComplete="off" id="host" name="host" onChange={(event) => setHost(event.target.value)} placeholder={t("server.hostPlaceholder")} spellCheck={false} value={host} required />
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
      {/* Rendered last so it stacks above the server dialog when opened from there. */}
      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} onSave={saveSettingsDialog} servers={savedHosts} settings={appSettings} systemLocale={systemLocale} />
      )}
    </div>
  );
}

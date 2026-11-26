import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Dialog from "./Dialog";
import { t } from "./i18n";
import { cdCommand, formatSize, MAX_EDIT_BYTES, joinRemote, parentDir, sftpApi, sftpError, sftpStore, type ConnectOptions, type FileEntry, type SftpConnection } from "./sftp";
import { serverAddress } from "./labels";
import type { SavedHost } from "./terminalTypes";
import { useFloatingMenu } from "./useFloatingMenu";

/** Where the browser stands; used for files dropped onto it. */
export type FileLocation = { connection: SftpConnection; server: SavedHost; dir: string };

type FilePanelProps = {
  /** Server of the active pane; null for a local shell or no tab. */
  server: SavedHost | null;
  options: ConnectOptions;
  /** The "Snippets | Files" switch. */
  panelSwitch: ReactNode;
  /** Files are being dragged over the browser. */
  dropActive: boolean;
  onHide: () => void;
  onLocation: (location: FileLocation | null) => void;
  onUpload: (location: FileLocation, localPaths: string[]) => void;
  /** Inserts `cd '…'` into the terminal of the active tab (without Enter). */
  onCd: (command: string) => void;
  /** Folder the active terminal reported ("" when unknown; may start with "~"). */
  terminalDir: string;
  /** Change the folder (terminal menu "Open folder in the file browser"); `nonce` repeats it. */
  openRequest: { dir: string; nonce: number } | null;
  follow: boolean;
  onFollow: (follow: boolean) => void;
  /** Program for "Edit" ("" = the system's default application). */
  editor: string;
};

type EntryAction = "open" | "download" | "edit" | "cd" | "rename" | "delete";

type Status = { state: "idle" } | { state: "loading" } | { state: "error"; message: string };

function sortEntries(entries: FileEntry[], showHidden: boolean): FileEntry[] {
  return entries
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

function formatDate(seconds: number): string {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString(undefined, { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** A name is one path segment: not empty, no "/", not "." or "..". */
function validName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/");
}

/** Inline field for a new folder or a new name. Enter saves, Escape cancels. */
function NameField({ initial, label, onDone }: { initial: string; label: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // Select the name without the extension, like file managers do.
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value === null ? null : value.trim());
  };
  return (
    <input
      aria-label={label}
      autoComplete="off"
      className="file-name-field"
      defaultValue={initial}
      onBlur={(event) => finish(event.currentTarget.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(event.currentTarget.value);
        else if (event.key === "Escape") finish(null);
      }}
      spellCheck={false}
    />
  );
}

function EntryMenu({ entry, x, y, onAction, onClose }: {
  entry: FileEntry;
  x: number;
  y: number;
  onAction: (action: EntryAction) => void;
  onClose: () => void;
}) {
  const { ref, position, handleMenuKey } = useFloatingMenu({ x, y, onClose });
  const tooLarge = entry.size > MAX_EDIT_BYTES;
  const items: { action: EntryAction; label: string; separator?: boolean; disabled?: boolean; hint?: string }[] = [
    ...(entry.isDir
      ? [{ action: "open" as const, label: t("files.open") }, { action: "download" as const, label: t("files.downloadFolder") }]
      : [
        { action: "edit" as const, label: t("files.edit"), disabled: tooLarge, hint: tooLarge ? t("files.editTooLarge") : t("files.editHint") },
        { action: "download" as const, label: t("files.download") },
      ]),
    { action: "cd", label: entry.isDir ? t("files.cdHere") : t("files.cdFolder") },
    { action: "rename", label: t("files.rename"), separator: true },
    { action: "delete", label: t("files.delete") },
  ];
  return (
    <div aria-label={t("files.menu")} className="context-menu" onContextMenu={(event) => event.preventDefault()} onKeyDown={handleMenuKey} ref={ref} role="menu" style={position}>
      {items.map((item) => (
        <button className={`context-menu-item${item.separator ? " context-menu-separated" : ""}`} disabled={item.disabled} key={item.action} onClick={() => onAction(item.action)} role="menuitem" title={item.hint} type="button">{item.label}</button>
      ))}
    </div>
  );
}

/** Files opened with "Edit": upload after saving, conflicts, open again, close. */
function EditList({ editor }: { editor: string }) {
  useSyncExternalStore(sftpStore.subscribe, sftpStore.getVersion);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const edits = sftpStore.getEdits();
  if (edits.length === 0) return null;
  return (
    <div aria-label={t("files.edited")} className="file-transfers file-edits" role="list">
      <div className="file-transfers-heading"><span>{t("files.edited")}</span></div>
      {edits.map((item) => {
        const pending = item.state === "changed" || item.state === "conflict" || item.state === "failed";
        const status = {
          open: t("files.editOpen"),
          changed: t("files.editChanged"),
          uploading: t("files.editUploading"),
          saved: t("files.editSaved"),
          conflict: t("files.editConflict"),
          failed: item.error,
        }[item.state];
        return (
          <div className={`file-edit file-edit-${item.state}`} key={item.editId} role="listitem" title={`${item.serverName}: ${item.remotePath}`}>
            <div className="file-transfer-line">
              <span aria-hidden="true">✎</span>
              <span className="file-transfer-name">{item.name}</span>
              <button aria-label={t("files.editShow", { name: item.name })} className="file-transfer-cancel" onClick={() => void sftpStore.showEdit(item.editId, editor)} title={t("files.editShow", { name: item.name })} type="button">↗</button>
              <button
                aria-label={t("files.editClose", { name: item.name })}
                className="file-transfer-cancel"
                onClick={() => (pending ? setDiscarding(item.editId) : sftpStore.closeEdit(item.editId))}
                title={t("files.editClose", { name: item.name })}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="file-transfer-status">{status}</div>
            {discarding === item.editId ? (
              <div className="file-edit-actions">
                <span>{t("files.editDiscardQuestion")}</span>
                <button className="text-action" onClick={() => { setDiscarding(null); sftpStore.closeEdit(item.editId); }} type="button">{t("files.editDiscard")}</button>
                <button className="text-action" onClick={() => setDiscarding(null)} type="button">{t("common.cancel")}</button>
              </div>
            ) : (
              <div className="file-edit-actions">
                {item.state === "changed" && <button className="button button-primary file-edit-upload" onClick={() => void sftpStore.uploadEdit(item.editId, false)} type="button">{t("files.editUpload")}</button>}
                {item.state === "conflict" && <button className="button button-danger file-edit-upload" onClick={() => void sftpStore.uploadEdit(item.editId, true)} type="button">{t("files.editOverwrite")}</button>}
                {item.state === "failed" && <button className="button button-secondary file-edit-upload" onClick={() => void sftpStore.uploadEdit(item.editId, false)} type="button">{t("files.retry")}</button>}
                <label className="file-hidden-toggle" title={t("files.editAutoTitle")}>
                  <input checked={item.auto} onChange={(event) => sftpStore.setAutoUpload(item.editId, event.target.checked)} type="checkbox" />
                  <span>{t("files.editAuto")}</span>
                </label>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TransferList() {
  useSyncExternalStore(sftpStore.subscribe, sftpStore.getVersion);
  const transfers = sftpStore.getTransfers();
  if (transfers.length === 0) return null;
  const finished = transfers.some((item) => item.state !== "running");
  return (
    <div aria-label={t("files.transfers")} className="file-transfers" role="list">
      <div className="file-transfers-heading">
        <span>{t("files.transfers")}</span>
        {finished && <button className="text-action" onClick={() => sftpStore.clearFinished()} type="button">{t("files.clearFinished")}</button>}
      </div>
      {transfers.map((item) => {
        const share = item.total ? Math.min(100, (item.bytes / item.total) * 100) : item.state === "done" ? 100 : 0;
        const failed = item.failed ? t("files.failedCount", { count: item.failed }) : "";
        const status = item.state === "running"
          ? `${formatSize(item.bytes)} / ${formatSize(item.total)}${item.current !== item.file ? ` · ${item.current}` : ""}`
          : item.state === "done" ? t("files.done") : item.state === "cancelled" ? t("files.cancelled") : [failed, item.error].filter(Boolean).join(" · ");
        return (
          <div className={`file-transfer file-transfer-${item.state}`} key={item.key} role="listitem" title={`${item.server}: ${item.file}`}>
            <div className="file-transfer-line">
              <span aria-hidden="true">{item.direction === "up" ? "↑" : "↓"}</span>
              <span className="file-transfer-name">{item.file}</span>
              {item.state === "running" && <button aria-label={t("files.cancelTransfer", { name: item.file })} className="file-transfer-cancel" onClick={() => sftpStore.cancel(item.transferId)} title={t("files.cancelTransfer", { name: item.file })} type="button">×</button>}
            </div>
            <div className="file-transfer-bar"><span style={{ width: `${share}%` }} /></div>
            <div className="file-transfer-status">{status}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Right-hand file browser (SFTP) for the server of the active tab. */
export default function FilePanel({ server, options, panelSwitch, dropActive, onHide, onLocation, onUpload, onCd, terminalDir, openRequest, follow, onFollow, editor }: FilePanelProps) {
  const [connection, setConnection] = useState<SftpConnection | null>(null);
  const [dir, setDir] = useState("");
  const [pathText, setPathText] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [notice, setNotice] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{ entry: FileEntry; x: number; y: number } | null>(null);
  const [deleting, setDeleting] = useState<FileEntry | null>(null);
  const [attempt, setAttempt] = useState(0);
  useSyncExternalStore(sftpStore.subscribe, sftpStore.getVersion);
  const requestRef = useRef(0);
  const serverName = server ? server.label || serverAddress(server) : "";
  const changes = connection ? sftpStore.changeCount(connection.id, dir) : 0;

  /** Lists a folder and shows it; false when it failed (the error is shown). */
  async function load(open: SftpConnection, path: string): Promise<boolean> {
    const request = ++requestRef.current;
    setStatus({ state: "loading" });
    try {
      const list = await sftpApi.list(open, path);
      if (request !== requestRef.current) return false;
      setEntries(list);
      setDir(path);
      setPathText(path);
      setStatus({ state: "idle" });
      if (server) sftpStore.setLastDir(server.id, path);
      return true;
    } catch (error) {
      if (request !== requestRef.current) return false;
      setPathText(path);
      setStatus({ state: "error", message: sftpError(error) });
      return false;
    }
  }

  // Connect when the server of the active tab changes (or "Try again").
  useEffect(() => {
    setConnection(null);
    setEntries([]);
    setSelected(null);
    setNotice("");
    if (!server) {
      setStatus({ state: "idle" });
      return;
    }
    let active = true;
    setStatus({ state: "loading" });
    sftpStore.connect(server, options).then(
      (open) => {
        if (!active) return;
        setConnection(open);
        // The remembered folder may be gone meanwhile: fall back to the home directory.
        const last = sftpStore.lastDir(server.id);
        void load(open, last ?? open.home).then((shown) => {
          if (!shown && active && last && last !== open.home) void load(open, open.home);
        });
      },
      (error: unknown) => { if (active) setStatus({ state: "error", message: sftpError(error) }); },
    );
    return () => { active = false; requestRef.current += 1; };
    // Reconnect only for a different server or connection settings.
  }, [server?.id, server?.host, server?.port, server?.username, server?.identityFile, server?.useProxy, options.proxy, options.keepaliveSeconds, attempt]);

  // Uploads into the shown folder finished: show the new files.
  useEffect(() => {
    if (connection && dir && changes > 0) void load(connection, dir);
  }, [changes]);

  useEffect(() => {
    onLocation(connection && server && dir ? { connection, server, dir } : null);
  }, [connection, server, dir, onLocation]);

  // Terminal menu "Open folder in the file browser": once the connection is there.
  const handledRequest = useRef(0);
  useEffect(() => {
    if (!connection || !openRequest || openRequest.nonce === handledRequest.current) return;
    handledRequest.current = openRequest.nonce;
    void goTo(openRequest.dir);
  }, [connection, openRequest]);

  // "Follow the terminal": every cd in the shell (that it reports) changes the folder here too.
  useEffect(() => {
    if (follow && connection && terminalDir) void goTo(terminalDir);
  }, [follow, connection, terminalDir]);

  const visible = sortEntries(entries, showHidden);
  const busy = status.state === "loading";

  async function run(action: () => Promise<void>) {
    if (!connection) return;
    setNotice("");
    try {
      await action();
      await load(connection, dir);
    } catch (error) {
      setNotice(sftpError(error));
    }
  }

  function open(entry: FileEntry) {
    if (connection && entry.isDir) void load(connection, joinRemote(dir, entry.name));
  }

  async function download(entry: FileEntry) {
    if (!connection) return;
    setNotice("");
    try {
      const saved = await sftpStore.download(connection, serverName, joinRemote(dir, entry.name), entry.isDir);
      if (saved) setNotice(t("files.downloaded", { path: saved }));
    } catch (error) {
      setNotice(sftpError(error));
    }
  }

  async function goTo(text: string) {
    if (!connection) return;
    const target = text.trim() || "/";
    try {
      // Relative paths start in the shown folder; "~" is the home directory.
      const absolute = target.startsWith("/") ? target : target === "~" ? connection.home : target.startsWith("~/") ? joinRemote(connection.home, target.slice(2)) : joinRemote(dir, target);
      await load(connection, await sftpApi.realpath(connection, absolute));
    } catch (error) {
      setNotice(sftpError(error));
      setPathText(dir);
    }
  }

  async function pickAndUpload(folders: boolean) {
    if (!connection || !server) return;
    const paths = await sftpApi.pickFiles(folders).catch((error: unknown) => { setNotice(sftpError(error)); return []; });
    if (paths.length) onUpload({ connection, server, dir }, paths);
  }

  function menuAction(entry: FileEntry, action: EntryAction) {
    setMenu(null);
    if (action === "open") open(entry);
    else if (action === "download") void download(entry);
    else if (action === "edit") {
      if (!connection || !server) return;
      setNotice("");
      sftpStore.edit(connection, server, options, joinRemote(dir, entry.name), editor).catch((error: unknown) => setNotice(sftpError(error)));
    }
    else if (action === "cd") onCd(cdCommand(entry.isDir ? joinRemote(dir, entry.name) : dir));
    else if (action === "rename") setRenaming(entry.name);
    else setDeleting(entry);
  }

  return (
    <aside aria-label={t("files.title")} className={`sidebar snippet-panel file-panel${dropActive ? " file-panel-drop" : ""}`} id="snippet-panel">
      <div className="server-list-heading">
        {panelSwitch}
        <div className="sidebar-heading-actions">
          <button aria-label={t("snippetPanel.hide")} className="icon-button" onClick={onHide} title={t("snippetPanel.hide")} type="button"><span aria-hidden="true">›</span></button>
        </div>
      </div>

      {!server ? (
        <div className="sidebar-empty">{t("files.noServer")}</div>
      ) : (
        <>
          <div className="file-server" title={serverAddress(server)}>{serverName}</div>
          <div className="file-toolbar">
            <button aria-label={t("files.up")} className="icon-button" disabled={!connection || busy || dir === "/"} onClick={() => connection && void load(connection, parentDir(dir))} title={t("files.up")} type="button">↑</button>
            <input
              aria-label={t("files.path")}
              autoComplete="off"
              className="file-path"
              disabled={!connection}
              onChange={(event) => setPathText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void goTo(pathText);
                else if (event.key === "Escape") setPathText(dir);
              }}
              spellCheck={false}
              title={dir}
              value={pathText}
            />
            <button aria-label={t("files.reload")} className="icon-button" disabled={!connection || busy} onClick={() => connection && void load(connection, dir)} title={t("files.reload")} type="button">↻</button>
            <button aria-label={t("files.terminalDir")} className="icon-button" disabled={!connection || !terminalDir} onClick={() => void goTo(terminalDir)} title={terminalDir ? `${t("files.terminalDir")}: ${terminalDir}` : t("files.terminalDirUnknown")} type="button">⌖</button>
          </div>
          <div className="file-actions">
            <button className="text-action" disabled={!connection || busy} onClick={() => setCreating(true)} type="button">{t("files.newFolder")}</button>
            <button className="text-action" disabled={!connection || busy} onClick={() => void pickAndUpload(false)} type="button">{t("files.upload")}</button>
            <button className="text-action" disabled={!connection || busy} onClick={() => void pickAndUpload(true)} type="button">{t("files.uploadFolder")}</button>
            <label className="file-hidden-toggle" title={t("files.followTitle")}>
              <input checked={follow} onChange={(event) => onFollow(event.target.checked)} type="checkbox" />
              <span>{t("files.follow")}</span>
            </label>
            <label className="file-hidden-toggle" title={t("files.hiddenTitle")}>
              <input checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} type="checkbox" />
              <span>{t("files.hidden")}</span>
            </label>
          </div>
          {notice && <div aria-live="polite" className="page-notice file-notice">{notice}</div>}

          <div aria-busy={busy} aria-label={t("files.list")} className="file-list" role="list">
            {status.state === "error" ? (
              <div aria-live="polite" className="sidebar-storage-error">
                {status.message}
                <button
                  className="text-action file-retry"
                  onClick={() => {
                    // Start over with a fresh connection: the old one may be dead (network change).
                    if (connection) sftpStore.forget(connection);
                    setAttempt((value) => value + 1);
                  }}
                  type="button"
                >
                  {t("files.retry")}
                </button>
              </div>
            ) : (
              <>
                {creating && (
                  <div className="file-row" role="listitem">
                    <span aria-hidden="true" className="file-icon">📁</span>
                    <NameField
                      initial=""
                      label={t("files.newFolder")}
                      onDone={(name) => {
                        setCreating(false);
                        if (name === null || name === "") return;
                        if (!validName(name)) return setNotice(t("files.invalidName"));
                        void run(() => sftpApi.mkdir(connection as SftpConnection, joinRemote(dir, name)));
                      }}
                    />
                  </div>
                )}
                {busy && entries.length === 0 && <div className="sidebar-empty">{t("files.loading")}</div>}
                {!busy && visible.length === 0 && !creating && <div className="sidebar-empty">{t("files.empty")}</div>}
                {visible.map((entry) => (
                  <div
                    aria-selected={selected === entry.name}
                    className={`file-row${selected === entry.name ? " file-row-selected" : ""}`}
                    key={entry.name}
                    onClick={() => setSelected(entry.name)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setSelected(entry.name);
                      setMenu({ entry, x: event.clientX, y: event.clientY });
                    }}
                    onDoubleClick={() => (entry.isDir ? open(entry) : void download(entry))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        if (entry.isDir) open(entry);
                        else void download(entry);
                      } else if (event.key === "F2") setRenaming(entry.name);
                      else if (event.key === "Delete") setDeleting(entry);
                    }}
                    role="listitem"
                    tabIndex={0}
                    title={entry.isDir ? t("files.openHint") : t("files.downloadHint")}
                  >
                    <span aria-hidden="true" className="file-icon">{entry.isDir ? "📁" : entry.isLink ? "🔗" : "📄"}</span>
                    {renaming === entry.name ? (
                      <NameField
                        initial={entry.name}
                        label={t("files.rename")}
                        onDone={(name) => {
                          setRenaming(null);
                          if (name === null || name === entry.name || name === "") return;
                          if (!validName(name)) return setNotice(t("files.invalidName"));
                          void run(() => sftpApi.rename(connection as SftpConnection, joinRemote(dir, entry.name), joinRemote(dir, name)));
                        }}
                      />
                    ) : (
                      <span className="file-name">{entry.name}</span>
                    )}
                    <span className="file-meta">{entry.isDir ? "" : formatSize(entry.size)}</span>
                    <span className="file-meta file-date">{formatDate(entry.modified)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
          <div className="file-drop-hint">{dropActive ? t("files.dropHere", { dir }) : t("files.dragHint")}</div>
        </>
      )}
      <EditList editor={editor} />
      <TransferList />

      {menu && <EntryMenu entry={menu.entry} onAction={(action) => menuAction(menu.entry, action)} onClose={() => setMenu(null)} x={menu.x} y={menu.y} />}
      {deleting && (
        <Dialog className="paste-dialog" closeLabel={t("common.cancel")} onClose={() => setDeleting(null)} title={deleting.isDir ? t("files.deleteFolderTitle") : t("files.deleteFileTitle")} titleId="file-delete-title">
          <div className="form-footnote">{t(deleting.isDir ? "files.deleteFolderText" : "files.deleteFileText", { name: deleting.name, server: serverName })}</div>
          <div className="editor-actions">
            <button autoFocus className="button button-secondary" onClick={() => setDeleting(null)} type="button">{t("common.cancel")}</button>
            <button
              className="button button-danger"
              onClick={() => {
                const entry = deleting;
                setDeleting(null);
                void run(() => sftpApi.remove(connection as SftpConnection, joinRemote(dir, entry.name), entry.isDir));
              }}
              type="button"
            >
              {t("files.delete")}
            </button>
          </div>
        </Dialog>
      )}
    </aside>
  );
}

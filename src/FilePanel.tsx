import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Dialog from "./Dialog";
import { t } from "./i18n";
import { cdCommand, formatSize, MAX_EDIT_BYTES, joinRemote, parentDir, sftpApi, sftpError, sftpStore, type ConnectOptions, type FileEntry, type RemoteItem, type SftpConnection } from "./sftp";
import { serverAddress } from "./labels";
import type { SavedHost } from "./terminalTypes";
import { useFileDrag, type DragSource } from "./useFileDrag";
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

type EntryAction = "open" | "download" | "edit" | "cut" | "copy" | "paste" | "cd" | "rename" | "delete";

/** Whether "Paste" works in a folder: null without anything copied, else a reason it does not. */
type PasteState = { possible: boolean } | null;

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
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    const focus = () => {
      if (done.current || document.activeElement === input) return;
      input.focus();
      // Select the name without the extension, like file managers do.
      const dot = initial.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    };
    focus();
    // A menu that just closed or the button that was clicked may take the focus back.
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
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
      ref={ref}
      spellCheck={false}
    />
  );
}

function EntryMenu({ entry, x, y, paste, onAction, onClose }: {
  entry: FileEntry;
  x: number;
  y: number;
  /** Pasting into this folder (only folders). */
  paste: PasteState;
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
    { action: "cut", label: t("files.cut"), separator: true },
    { action: "copy", label: t("files.copy") },
    ...(entry.isDir && paste ? [{ action: "paste" as const, label: t("files.pasteInto"), disabled: !paste.possible, hint: paste.possible ? undefined : t("files.pasteBlocked") }] : []),
    { action: "cd", label: entry.isDir ? t("files.cdHere") : t("files.cdFolder"), separator: true },
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

/** Right click on the free space of the list: paste into the shown folder, new folder. */
function ListMenu({ x, y, paste, onPaste, onNewFolder, onClose }: {
  x: number;
  y: number;
  paste: PasteState;
  onPaste: () => void;
  onNewFolder: () => void;
  onClose: () => void;
}) {
  const { ref, position, handleMenuKey } = useFloatingMenu({ x, y, onClose });
  return (
    <div aria-label={t("files.menu")} className="context-menu" onContextMenu={(event) => event.preventDefault()} onKeyDown={handleMenuKey} ref={ref} role="menu" style={position}>
      <button className="context-menu-item" disabled={!paste?.possible} onClick={onPaste} role="menuitem" title={paste && !paste.possible ? t("files.pasteBlocked") : undefined} type="button">{t("files.paste")}</button>
      <button className="context-menu-item" onClick={onNewFolder} role="menuitem" type="button">{t("files.newFolder")}</button>
    </div>
  );
}

type DropRequest = { source: DragSource; dir: string; x: number; y: number; conflict: boolean };

/** After a file or folder was dropped on a folder: always ask whether to move or copy it. */
function DropMenu({ request, serverName, sameServer, onMove, onCopy, onClose }: {
  request: DropRequest;
  serverName: string;
  sameServer: boolean;
  onMove: () => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  const { ref, position, handleMenuKey } = useFloatingMenu({ x: request.x, y: request.y, onClose });
  const { source, dir, conflict } = request;
  // A rename on the same server cannot replace anything.
  const moveBlocked = sameServer && conflict;
  return (
    <div aria-label={t("files.dropMenu")} className="context-menu file-drop-menu" onContextMenu={(event) => event.preventDefault()} onKeyDown={handleMenuKey} ref={ref} role="menu" style={position}>
      <div className="file-drop-menu-title" title={`${serverName}: ${dir}`}>{t("files.dropTo", { name: source.name, server: serverName, dir })}</div>
      {conflict && <div className="file-drop-menu-note">{t("files.dropConflict", { name: source.name })}</div>}
      <button className="context-menu-item" disabled={moveBlocked} onClick={onMove} role="menuitem" title={moveBlocked ? t("files.dropMoveBlocked") : undefined} type="button">
        {sameServer ? t("files.dropMove") : t("files.dropMoveOther", { server: source.serverName })}
      </button>
      <button className="context-menu-item" onClick={onCopy} role="menuitem" type="button">{t("files.dropCopy")}</button>
      <button className="context-menu-item context-menu-separated" onClick={onClose} role="menuitem" type="button">{t("common.cancel")}</button>
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
              <span aria-hidden="true">{{ up: "↑", down: "↓", copy: "⧉", move: "→" }[item.direction]}</span>
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
  /** Folder in which "New folder" was started; the field closes when another folder is shown. */
  const [creating, setCreating] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ entry: FileEntry | null; x: number; y: number } | null>(null);
  const [deleting, setDeleting] = useState<FileEntry | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [dropRequest, setDropRequest] = useState<DropRequest | null>(null);
  useSyncExternalStore(sftpStore.subscribe, sftpStore.getVersion);
  const requestRef = useRef(0);
  const serverName = server ? server.label || serverAddress(server) : "";
  const changes = connection ? sftpStore.changeCount(connection.id, dir) : 0;

  /** Lists a folder and shows it: "failed" shows the error, "stale" means a newer request took over. */
  async function load(open: SftpConnection, path: string): Promise<"shown" | "failed" | "stale"> {
    const request = ++requestRef.current;
    setStatus({ state: "loading" });
    try {
      const list = await sftpApi.list(open, path);
      if (request !== requestRef.current) return "stale";
      setEntries(list);
      setDir(path);
      setPathText(path);
      setStatus({ state: "idle" });
      if (server) sftpStore.setLastDir(server.id, path);
      return "shown";
    } catch (error) {
      if (request !== requestRef.current) return "stale";
      setPathText(path);
      setStatus({ state: "error", message: sftpError(error) });
      return "failed";
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
        // Not when a newer request (e.g. "Follow the terminal") took over meanwhile.
        const last = sftpStore.lastDir(server.id);
        void load(open, last ?? open.home).then((result) => {
          if (result === "failed" && active && last && last !== open.home) void load(open, open.home);
        });
      },
      (error: unknown) => { if (active) setStatus({ state: "error", message: sftpError(error) }); },
    );
    return () => { active = false; requestRef.current += 1; };
    // Reconnect only for a different server or connection settings.
  }, [server?.id, server?.host, server?.port, server?.username, server?.identityFile, server?.useProxy, options.proxy, options.keepaliveSeconds, attempt]);

  // Another folder or server: a half-typed new name does not belong there.
  useEffect(() => {
    setCreating(null);
    setRenaming(null);
  }, [dir, connection]);

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

  /** Whether `source` can go into `target` on the server shown now. */
  function canPlace(source: RemoteItem, target: string): boolean {
    if (!connection || status.state === "error") return false;
    if (source.connection.id !== connection.id) return true;
    // Not where it already is, not onto or into itself.
    return target !== source.parent && target !== source.path && !target.startsWith(`${source.path.replace(/\/+$/, "")}/`);
  }

  const clip = sftpStore.getClipboard();
  const pasteState = (target: string): PasteState => (clip ? { possible: canPlace(clip.item, target) } : null);

  /** "Paste": straight away, unless the name is taken there (then ask, like after a drop). */
  function paste(target: string, x: number, y: number) {
    setMenu(null);
    const current = sftpStore.getClipboard();
    if (!connection || !current) return;
    if (!canPlace(current.item, target)) return setNotice(t("files.pasteBlocked"));
    const open = connection;
    void sftpApi.existing(open, [joinRemote(target, current.item.name)]).catch(() => []).then((existing) => {
      if (requestConnection.current !== open) return;
      if (existing.length > 0) return setDropRequest({ source: current.item, dir: target, x, y, conflict: true });
      place(current.item, target, !current.cut);
    });
  }

  function itemOf(entry: FileEntry): RemoteItem | null {
    return connection ? { connection, serverName, path: joinRemote(dir, entry.name), name: entry.name, isDir: entry.isDir, parent: dir } : null;
  }

  function clipEntry(entry: FileEntry, cut: boolean) {
    const item = itemOf(entry);
    if (!item) return;
    sftpStore.setClipboard({ item, cut });
    setNotice(t(cut ? "files.cutDone" : "files.copyDone", { name: entry.name }));
  }

  const fileDrag = useFileDrag({
    canDrop: canPlace,
    onDrop: (source, target, x, y) => {
      if (!connection) return;
      const open = connection;
      void sftpApi.existing(open, [joinRemote(target, source.name)]).catch(() => []).then((existing) => {
        // Still the same server (the tab may have changed meanwhile).
        if (requestConnection.current === open) setDropRequest({ source, dir: target, x, y, conflict: existing.length > 0 });
      });
    },
  });
  const requestConnection = useRef<SftpConnection | null>(null);
  requestConnection.current = connection;
  useEffect(() => setDropRequest(null), [connection]);

  function dropAction(request: DropRequest, copy: boolean) {
    setDropRequest(null);
    place(request.source, request.dir, copy);
  }

  /** Moves or copies `source` into `target` on the server shown now. */
  function place(source: RemoteItem, target: string, copy: boolean) {
    if (!connection) return;
    setNotice("");
    // A cut item is pasted once.
    const current = sftpStore.getClipboard();
    if (!copy && current?.cut && current.item.path === source.path && current.item.connection.id === source.connection.id) sftpStore.setClipboard(null);
    if (!copy && source.connection.id === connection.id) {
      const open = connection;
      void sftpApi.move(open, source.path, target).then(
        () => {
          sftpStore.folderChanged(open, target);
          sftpStore.folderChanged(open, source.parent);
        },
        (error: unknown) => setNotice(sftpError(error)),
      );
      return;
    }
    sftpStore.copy(source.connection, source.path, source.isDir, connection, serverName, target, !copy).catch((error: unknown) => setNotice(sftpError(error)));
  }

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
    else if (action === "cut" || action === "copy") clipEntry(entry, action === "cut");
    else if (action === "paste") paste(joinRemote(dir, entry.name), menu?.x ?? 0, menu?.y ?? 0);
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
            <button aria-label={t("files.up")} className={`icon-button${fileDrag.targetDir && fileDrag.targetDir === parentDir(dir) && dir !== "/" ? " file-drop-target" : ""}`} data-drop-dir={dir && dir !== "/" ? parentDir(dir) : undefined} disabled={!connection || busy || dir === "/"} onClick={() => connection && void load(connection, parentDir(dir))} title={t("files.up")} type="button">↑</button>
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
            <button className="text-action" disabled={!connection || busy} onClick={() => setCreating(dir)} type="button">{t("files.newFolder")}</button>
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

          <div aria-busy={busy} aria-label={t("files.list")} className={`file-list${fileDrag.targetDir && fileDrag.targetDir === dir ? " file-list-drop" : ""}`}
            data-drop-dir={dir || undefined}
            onContextMenu={(event) => {
              event.preventDefault();
              if (connection && status.state !== "error") setMenu({ entry: null, x: event.clientX, y: event.clientY });
            }}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v" && connection) {
                event.preventDefault();
                const rect = (event.target as HTMLElement).getBoundingClientRect();
                paste(dir, rect.left + 24, rect.bottom);
              }
            }}
            role="list"
          >
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
                {creating !== null && creating === dir && (
                  <div className="file-row" role="listitem">
                    <span aria-hidden="true" className="file-icon">📁</span>
                    <NameField
                      initial=""
                      label={t("files.newFolder")}
                      onDone={(name) => {
                        const parent = creating;
                        setCreating(null);
                        if (name === null || name === "" || parent !== dir) return;
                        if (!validName(name)) return setNotice(t("files.invalidName"));
                        void run(() => sftpApi.mkdir(connection as SftpConnection, joinRemote(parent, name)));
                      }}
                    />
                  </div>
                )}
                {busy && entries.length === 0 && <div className="sidebar-empty">{t("files.loading")}</div>}
                {!busy && visible.length === 0 && creating !== dir && <div className="sidebar-empty">{t("files.empty")}</div>}
                {visible.map((entry) => {
                  const path = joinRemote(dir, entry.name);
                  return (
                  <div
                    aria-selected={selected === entry.name}
                    className={`file-row${selected === entry.name ? " file-row-selected" : ""}${fileDrag.draggingPath === path || (clip?.cut && clip.item.path === path && clip.item.connection.id === connection?.id) ? " list-drag-source" : ""}${entry.isDir && fileDrag.targetDir === path ? " file-drop-target" : ""}`}
                    data-drop-dir={entry.isDir ? path : undefined}
                    key={entry.name}
                    {...fileDrag.sourceProps(() => connection && renaming !== entry.name ? { connection, serverName, path, name: entry.name, isDir: entry.isDir, parent: dir } : null)}
                    onClick={() => setSelected(entry.name)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSelected(entry.name);
                      setMenu({ entry, x: event.clientX, y: event.clientY });
                    }}
                    onDoubleClick={() => (entry.isDir ? open(entry) : void download(entry))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        if (entry.isDir) open(entry);
                        else void download(entry);
                      } else if ((event.ctrlKey || event.metaKey) && ["c", "x"].includes(event.key.toLowerCase())) {
                        event.preventDefault();
                        clipEntry(entry, event.key.toLowerCase() === "x");
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
                  );
                })}
              </>
            )}
          </div>
          <div className="file-drop-hint">{dropActive ? t("files.dropHere", { dir }) : t("files.dragHint")}</div>
        </>
      )}
      <EditList editor={editor} />
      <TransferList />

      {fileDrag.overlay}
      {dropRequest && connection && (
        <DropMenu
          onClose={() => setDropRequest(null)}
          onCopy={() => dropAction(dropRequest, true)}
          onMove={() => dropAction(dropRequest, false)}
          request={dropRequest}
          sameServer={dropRequest.source.connection.id === connection.id}
          serverName={serverName}
        />
      )}
      {menu?.entry && <EntryMenu entry={menu.entry} onAction={(action) => menuAction(menu.entry as FileEntry, action)} onClose={() => setMenu(null)} paste={menu.entry.isDir ? pasteState(joinRemote(dir, menu.entry.name)) : null} x={menu.x} y={menu.y} />}
      {menu && !menu.entry && (
        <ListMenu
          onClose={() => setMenu(null)}
          onNewFolder={() => { setMenu(null); setCreating(dir); }}
          onPaste={() => paste(dir, menu.x, menu.y)}
          paste={pasteState(dir)}
          x={menu.x}
          y={menu.y}
        />
      )}
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

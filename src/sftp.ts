import { Channel, invoke } from "@tauri-apps/api/core";
import { t, translateBackend } from "./i18n";
import type { ProxyConfig } from "./proxy";
import type { SavedHost } from "./terminalTypes";

/** One entry of a remote folder (FileEntry in src-tauri/src/sftp/protocol.rs). */
export type FileEntry = {
  name: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  /** Seconds since 1970; 0 when unknown. */
  modified: number;
  permissions: number;
};

type TransferEvent = { file: string; current: string; bytes: number; total: number; state: "running" | "done" | "failed" | "cancelled"; failed: number; error: string | null };

/** One file of an upload or download, as shown in the transfer list. */
export type Transfer = {
  key: string;
  transferId: string;
  direction: "up" | "down";
  server: string;
  /** File or folder name. */
  file: string;
  /** The file being copied right now (inside a folder: "site/css/a.css"). */
  current: string;
  bytes: number;
  total: number;
  state: TransferEvent["state"];
  /** Files inside a folder that could not be copied. */
  failed: number;
  error: string;
};

export type SftpConnection = { id: string; home: string };

/** A remote file opened with "Edit": watched locally, uploaded back when saved. */
export type EditedFile = {
  editId: string;
  server: SavedHost;
  options: ConnectOptions;
  serverName: string;
  remotePath: string;
  name: string;
  /** open: in the editor; changed: saved there, not uploaded; conflict: changed on the server too. */
  state: "open" | "changed" | "uploading" | "saved" | "conflict" | "failed";
  error: string;
  /** Upload every save without asking. */
  auto: boolean;
};

/** Same text as CHANGED_ON_SERVER in src-tauri/src/sftp/edit.rs. */
const CHANGED_ON_SERVER = "The file was changed on the server since it was opened";
/** Files up to this size can be edited (MAX_EDIT_BYTES in edit.rs). */
export const MAX_EDIT_BYTES = 5 * 1024 * 1024;

/** What a connection needs besides the server: the same proxy and keepalive as the terminal. */
export type ConnectOptions = { proxy: ProxyConfig | null; keepaliveSeconds: number | null };

/** Remote paths are POSIX paths, also when the local system is Windows. */
export function joinRemote(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

export function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const parent = trimmed.slice(0, trimmed.lastIndexOf("/"));
  return parent || "/";
}

export function localFileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** `cd '…'` with the path quoted for POSIX shells. */
export function cdCommand(path: string): string {
  return `cd '${path.replace(/'/g, "'\\''")}'`;
}

/** Connection key: a changed server (host, user, key, proxy …) gets a new connection. */
function connectionKey(server: SavedHost, options: ConnectOptions): string {
  return JSON.stringify([server.id, server.host, server.port, server.username, server.identityFile, server.useProxy ? options.proxy : null, options.keepaliveSeconds]);
}

/**
 * Open SFTP connections (one per server, shared by its tabs), the last folder per server and
 * the running transfers. Components subscribe for changes.
 */
class SftpStore {
  private connections = new Map<string, { serverId: string; promise: Promise<SftpConnection>; id?: string }>();
  private lastDirs = new Map<string, string>();
  private transfers: Transfer[] = [];
  /** Counts finished uploads per "connection id + folder", so a shown folder can reload. */
  private changes = new Map<string, number>();
  private listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private publish(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  connect(server: SavedHost, options: ConnectOptions): Promise<SftpConnection> {
    const key = connectionKey(server, options);
    const open = this.connections.get(key);
    if (open) return open.promise;
    const promise = invoke<SftpConnection>("sftp_connect", {
      request: {
        host: server.host,
        port: server.port,
        username: server.username || null,
        identityFile: server.identityFile || null,
        proxy: server.useProxy ? options.proxy : null,
        keepaliveSeconds: options.keepaliveSeconds,
      },
    });
    const entry: { serverId: string; promise: Promise<SftpConnection>; id?: string } = { serverId: server.id, promise };
    this.connections.set(key, entry);
    promise.then(
      (open) => { entry.id = open.id; },
      // A failed attempt is not kept, so "Try again" starts a new one.
      () => { if (this.connections.get(key) === entry) this.connections.delete(key); },
    );
    return promise;
  }

  /** Drops a connection (e.g. lost after a network change), so the next call reconnects. */
  forget(connection: SftpConnection): void {
    for (const [key, entry] of this.connections) {
      if (entry.id === connection.id) this.connections.delete(key);
    }
    void invoke("sftp_disconnect", { id: connection.id });
  }

  /** Closes the connections of servers that no tab shows any more. */
  keepOnly(serverIds: ReadonlySet<string>): void {
    for (const [key, entry] of this.connections) {
      if (serverIds.has(entry.serverId)) continue;
      this.connections.delete(key);
      void entry.promise.then((open) => invoke("sftp_disconnect", { id: open.id }), () => undefined);
    }
  }

  lastDir(serverId: string): string | undefined {
    return this.lastDirs.get(serverId);
  }

  setLastDir(serverId: string, dir: string): void {
    this.lastDirs.set(serverId, dir);
  }

  changeCount(connectionId: string, dir: string): number {
    return this.changes.get(`${connectionId}\n${dir}`) ?? 0;
  }

  getTransfers(): readonly Transfer[] {
    return this.transfers;
  }

  private updateTransfer(transferId: string, direction: Transfer["direction"], server: string, event: TransferEvent): void {
    const key = `${transferId}\n${event.file}`;
    const next: Transfer = { key, transferId, direction, server, file: event.file, current: event.current, bytes: event.bytes, total: event.total, state: event.state, failed: event.failed, error: event.error ? translateBackend(event.error) : "" };
    const index = this.transfers.findIndex((item) => item.key === key);
    this.transfers = index < 0 ? [...this.transfers, next] : this.transfers.map((item, position) => position === index ? next : item);
    this.publish();
  }

  /** Removes finished entries from the list. */
  clearFinished(): void {
    this.transfers = this.transfers.filter((item) => item.state === "running");
    this.publish();
  }

  cancel(transferId: string): void {
    void invoke("sftp_cancel", { transferId });
  }

  // ---------------------------------------------------------------- edit

  private edits: EditedFile[] = [];
  private attentionHandler: (() => void) | null = null;

  /** Called when a saved file waits for "Upload", so the file browser can be shown. */
  onAttention(handler: (() => void) | null): void {
    this.attentionHandler = handler;
  }

  getEdits(): readonly EditedFile[] {
    return this.edits;
  }

  private patchEdit(editId: string, patch: Partial<EditedFile>): void {
    this.edits = this.edits.map((item) => item.editId === editId ? { ...item, ...patch } : item);
    this.publish();
  }

  /** Opens a remote file in the editor; an already open one is just shown again. */
  async edit(connection: SftpConnection, server: SavedHost, options: ConnectOptions, remotePath: string, editor: string): Promise<void> {
    const open = this.edits.find((item) => item.server.id === server.id && item.remotePath === remotePath);
    if (open) {
      await invoke("sftp_edit_show", { editId: open.editId, editor });
      return;
    }
    const onEvent = new Channel<{ editId: string; state: "changed" }>();
    onEvent.onmessage = (event) => this.changed(event.editId);
    const editId = await invoke<string>("sftp_edit", { id: connection.id, remotePath, editor, onEvent });
    const serverName = server.label || `${server.username ? `${server.username}@` : ""}${server.host}`;
    this.edits = [...this.edits, { editId, server, options, serverName, remotePath, name: localFileName(remotePath), state: "open", error: "", auto: false }];
    this.publish();
  }

  private changed(editId: string): void {
    const item = this.edits.find((entry) => entry.editId === editId);
    if (!item || item.state === "uploading") return;
    if (item.auto && item.state !== "conflict") {
      void this.uploadEdit(editId, false);
      return;
    }
    this.patchEdit(editId, { state: "changed", error: "" });
    this.attentionHandler?.();
  }

  /** Uploads the saved file to where it came from; `force` overwrites a newer server copy. */
  async uploadEdit(editId: string, force: boolean): Promise<void> {
    const item = this.edits.find((entry) => entry.editId === editId);
    if (!item) return;
    this.patchEdit(editId, { state: "uploading", error: "" });
    const attempt = async () => {
      const connection = await this.connect(item.server, item.options);
      try {
        await invoke("sftp_edit_upload", { id: connection.id, editId, force });
      } catch (error) {
        // The connection may have been closed (tab closed, network change): once more with a new one.
        if (String(error).includes("file connection")) {
          this.forget(connection);
          const fresh = await this.connect(item.server, item.options);
          await invoke("sftp_edit_upload", { id: fresh.id, editId, force });
          return fresh;
        }
        throw error;
      }
      return connection;
    };
    try {
      const connection = await attempt();
      this.patchEdit(editId, { state: "saved" });
      // A browser showing that folder reloads (new size and date).
      const key = `${connection.id}\n${parentDir(item.remotePath)}`;
      this.changes.set(key, (this.changes.get(key) ?? 0) + 1);
      this.publish();
    } catch (error) {
      if (String(error) === CHANGED_ON_SERVER) this.patchEdit(editId, { state: "conflict" });
      else this.patchEdit(editId, { state: "failed", error: sftpError(error) });
      this.attentionHandler?.();
    }
  }

  setAutoUpload(editId: string, auto: boolean): void {
    this.patchEdit(editId, { auto });
  }

  showEdit(editId: string, editor: string): Promise<void> {
    return invoke("sftp_edit_show", { editId, editor });
  }

  /** Stops editing; the local copy is deleted (unsaved uploads are dropped). */
  closeEdit(editId: string): void {
    void invoke("sftp_edit_close", { editId });
    this.edits = this.edits.filter((item) => item.editId !== editId);
    this.publish();
  }

  /** Uploads local files into a remote folder; progress shows in the transfer list. */
  async upload(connection: SftpConnection, server: string, localPaths: string[], dir: string): Promise<void> {
    const transferId = crypto.randomUUID();
    const onProgress = new Channel<TransferEvent>();
    onProgress.onmessage = (event) => this.updateTransfer(transferId, "up", server, event);
    try {
      await invoke("sftp_upload", { id: connection.id, localPaths, remoteDir: dir, transferId, onProgress });
    } finally {
      const key = `${connection.id}\n${dir}`;
      this.changes.set(key, (this.changes.get(key) ?? 0) + 1);
      this.publish();
    }
  }

  /** Downloads a file (save dialog) or a whole folder (folder dialog); null when cancelled. */
  async download(connection: SftpConnection, server: string, path: string, isDir: boolean): Promise<string | null> {
    const transferId = crypto.randomUUID();
    const onProgress = new Channel<TransferEvent>();
    onProgress.onmessage = (event) => this.updateTransfer(transferId, "down", server, event);
    return invoke<string | null>("sftp_download", { id: connection.id, remotePath: path, isDir, transferId, onProgress });
  }
}

export const sftpStore = new SftpStore();

export const sftpApi = {
  list: (connection: SftpConnection, path: string) => invoke<FileEntry[]>("sftp_list", { id: connection.id, path }),
  realpath: (connection: SftpConnection, path: string) => invoke<string>("sftp_realpath", { id: connection.id, path }),
  mkdir: (connection: SftpConnection, path: string) => invoke<void>("sftp_mkdir", { id: connection.id, path }),
  rename: (connection: SftpConnection, from: string, to: string) => invoke<void>("sftp_rename", { id: connection.id, from, to }),
  remove: (connection: SftpConnection, path: string, isDir: boolean) => invoke<void>("sftp_remove", { id: connection.id, path, isDir }),
  existing: (connection: SftpConnection, paths: string[]) => invoke<string[]>("sftp_existing", { id: connection.id, paths }),
  pickFiles: (folders: boolean) => invoke<string[]>("sftp_pick_files", { folders }),
};

/** "1.2 MB" style sizes for the file list and the transfers. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Errors from the backend, translated; a lost connection is said plainly. */
export function sftpError(error: unknown): string {
  const text = translateBackend(error);
  return text || t("files.failed");
}

import { useEffect, useState } from "react";
import Dialog from "./Dialog";
import { t } from "./i18n";
import { joinRemote, localFileName, sftpApi, sftpError, type SftpConnection } from "./sftp";

export type UploadRequest = {
  connection: SftpConnection;
  serverName: string;
  localPaths: string[];
  dir: string;
  /** Dropped onto the terminal: the target folder can still be changed. */
  editable: boolean;
};

const SHOWN_NAMES = 6;

/** Confirms an upload: target folder (when dropped onto the terminal) and files that get replaced. */
export default function UploadDialog({ request, onConfirm, onCancel }: {
  request: UploadRequest;
  onConfirm: (dir: string) => void;
  onCancel: () => void;
}) {
  const { connection, localPaths } = request;
  const [dirText, setDirText] = useState(request.dir);
  const [checkedDir, setCheckedDir] = useState(request.dir);
  const [existing, setExisting] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const names = localPaths.map(localFileName);

  // Files in the target folder that would be replaced.
  useEffect(() => {
    let active = true;
    setExisting(null);
    sftpApi.existing(connection, names.map((name) => joinRemote(checkedDir, name))).then(
      (paths) => { if (active) setExisting(paths.map(localFileName)); },
      () => { if (active) setExisting([]); },
    );
    return () => { active = false; };
    // names follow localPaths, which do not change while the dialog is open.
  }, [connection, checkedDir]);

  /** The typed folder as an absolute, existing path ("~" is the home directory). */
  async function resolve(text: string): Promise<string | null> {
    const target = text.trim() || "/";
    const absolute = target === "~" ? connection.home : target.startsWith("~/") ? joinRemote(connection.home, target.slice(2)) : target.startsWith("/") ? target : joinRemote(connection.home, target);
    try {
      const resolved = await sftpApi.realpath(connection, absolute);
      setError("");
      setDirText(resolved);
      setCheckedDir(resolved);
      return resolved;
    } catch (failure) {
      setError(sftpError(failure));
      return null;
    }
  }

  async function confirm() {
    setBusy(true);
    const dir = request.editable && dirText !== checkedDir ? await resolve(dirText) : checkedDir;
    setBusy(false);
    if (dir) onConfirm(dir);
  }

  const replaced = existing ?? [];
  const title = names.length === 1 ? t("upload.titleOne", { name: names[0] }) : t("upload.title", { count: names.length });

  return (
    <Dialog className="paste-dialog" closeLabel={t("common.cancel")} onClose={onCancel} title={title} titleId="upload-title">
      <form onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
        <div className="form-footnote">{t("upload.text", { server: request.serverName })}</div>
        {request.editable ? (
          <>
            <label className="field-label" htmlFor="upload-dir">{t("upload.folder")}</label>
            <input autoComplete="off" autoFocus id="upload-dir" onBlur={() => { if (dirText !== checkedDir) void resolve(dirText); }} onChange={(event) => setDirText(event.target.value)} spellCheck={false} value={dirText} />
          </>
        ) : (
          <div className="upload-folder">{checkedDir}</div>
        )}
        <ul className="upload-names">
          {names.slice(0, SHOWN_NAMES).map((name, index) => <li key={`${index}-${name}`}>{name}</li>)}
          {names.length > SHOWN_NAMES && <li>{t("upload.more", { count: names.length - SHOWN_NAMES })}</li>}
        </ul>
        {replaced.length > 0 && <div className="editor-notice">{t("upload.replace", { names: replaced.join(", ") })}</div>}
        {error && <div aria-live="polite" className="editor-notice">{error}</div>}
        <div className="editor-actions">
          <button className="button button-secondary" onClick={onCancel} type="button">{t("common.cancel")}</button>
          <button autoFocus={!request.editable} className="button button-primary" disabled={busy || existing === null} type="submit">
            {replaced.length ? t("upload.replaceConfirm") : t("upload.confirm")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

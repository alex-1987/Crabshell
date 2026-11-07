import { useState, type FormEvent, type KeyboardEvent } from "react";
import Dialog from "./Dialog";
import { t } from "./i18n";
import type { PendingPaste } from "./terminalTypes";

/** "Don't ask again" choice of the paste dialog. */
export type PasteRemember = "session" | "never" | null;

/** Multi-line paste or snippet insert waiting for confirmation. Enter pastes. */
export function PasteConfirmDialog({ paste, targetName, onConfirm, onCancel }: {
  paste: PendingPaste;
  targetName: string;
  onConfirm: (remember: PasteRemember) => void;
  onCancel: () => void;
}) {
  const [remember, setRemember] = useState<PasteRemember>(null);
  const { text, source, execute } = paste;
  const lines = text.split(/\r\n|\r|\n/);
  const lineCount = text.endsWith("\n") || text.endsWith("\r") ? lines.length - 1 : lines.length;
  const preview = lines.slice(0, 12).join("\n") + (lines.length > 12 ? "\n…" : "");
  const snippet = source === "snippet";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onConfirm(remember);
  }

  /** Enter on a checkbox pastes too (a form only submits from text fields on its own). */
  function keyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      onConfirm(remember);
    }
  }

  return (
    <Dialog className="paste-dialog" closeLabel={t("paste.cancelLabel")} onClose={onCancel} title={snippet ? t("paste.snippetTitle") : t("paste.title")} titleId="paste-title">
      <form onKeyDown={keyDown} onSubmit={submit}>
        <div className="form-footnote">
          {t("paste.summary", { lines: lineCount, chars: text.length })} <strong>{targetName}</strong>. {t("paste.warning")}{execute && <> <strong>{t("paste.runWarning")}</strong></>}
        </div>
        <pre className="paste-preview">{preview}</pre>
        <label className="sidebar-setting">
          <input checked={remember === "session"} onChange={(event) => setRemember(event.target.checked ? "session" : null)} type="checkbox" />
          <span>{t("paste.dontAskSession")}</span>
        </label>
        {/* Snippets always ask (outside a "session" choice); the setting is for clipboard pastes. */}
        {!snippet && (
          <label className="sidebar-setting">
            <input checked={remember === "never"} onChange={(event) => setRemember(event.target.checked ? "never" : null)} type="checkbox" />
            <span>{t("paste.dontAskNever")}</span>
          </label>
        )}
        <div className="editor-actions">
          <button className="button button-secondary" onClick={onCancel} type="button">{t("common.cancel")}</button>
          <button autoFocus className="button button-primary" type="submit">{execute ? t("paste.confirmRun") : t("paste.confirm")}</button>
        </div>
      </form>
    </Dialog>
  );
}

/** A program asked to read the clipboard (OSC 52). Needs an explicit answer, so no backdrop close. */
export function ClipboardReadDialog({ targetName, onAllow, onDeny }: {
  targetName: string;
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <Dialog className="paste-dialog" closeLabel={t("clipRead.deny")} closeOnBackdrop={false} onClose={onDeny} title={t("clipRead.title")} titleId="clip-read-title">
      <div className="form-footnote">
        {t("clipRead.text", { name: targetName })} <strong>{t("clipRead.warning")}</strong> {t("clipRead.retry")}
      </div>
      <div className="editor-actions">
        <button autoFocus className="button button-secondary" onClick={onDeny} type="button">{t("clipRead.deny")}</button>
        <button className="button button-primary" onClick={onAllow} type="button">{t("clipRead.session")}</button>
      </div>
    </Dialog>
  );
}

/** Closing the window while sessions are still running. */
export function CloseConfirmDialog({ running, onConfirm, onCancel }: {
  running: number;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}) {
  const [dontAsk, setDontAsk] = useState(false);
  return (
    <Dialog className="paste-dialog" closeLabel={t("common.cancel")} onClose={onCancel} title={running === 1 ? t("closeApp.titleOne") : t("closeApp.title", { count: running })} titleId="close-title">
      <div className="form-footnote">{t("closeApp.text")}</div>
      <label className="sidebar-setting">
        <input checked={dontAsk} onChange={(event) => setDontAsk(event.target.checked)} type="checkbox" />
        <span>{t("closeApp.dontAsk")}</span>
      </label>
      <div className="editor-actions">
        <button autoFocus className="button button-secondary" onClick={onCancel} type="button">{t("common.cancel")}</button>
        <button className="button button-primary" onClick={() => onConfirm(dontAsk)} type="button">{t("closeApp.confirm")}</button>
      </div>
    </Dialog>
  );
}

import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import BrandMark from "./BrandMark";
import Dialog from "./Dialog";
import type { UpdateInfo } from "./updates";
import { t, translateBackend } from "./i18n";

const REPOSITORY_URL = "https://github.com/alex-1987/Crabshell";
const SPONSOR_URL = "https://github.com/sponsors/alex-1987";

type AboutDialogProps = {
  version: string;
  /** Newer release found by the update check, if any. */
  update: UpdateInfo | null;
  onDismissUpdate: () => void;
  onClose: () => void;
};

/** About Crabshell. Donations only open GitHub Sponsors in the browser; no payment in the app. */
export default function AboutDialog({ version, update, onDismissUpdate, onClose }: AboutDialogProps) {
  const [error, setError] = useState("");

  function open(url: string) {
    openUrl(url).catch((openError: unknown) => setError(t("about.openFailed", { error: translateBackend(openError) })));
  }

  return (
    <Dialog className="about-dialog" closeLabel={t("about.close")} onClose={onClose} title="Crabshell" titleId="about-title">
      <div className="about-brand">
        <BrandMark className="about-logo" size={72} />
        <div>
          <div className="about-version">{t("about.version", { version: version || "…" })}</div>
          <div className="about-tagline">{t("about.tagline")}</div>
        </div>
      </div>
      {update && (
        <div className="about-update">
          <span>{t("update.available", { version: update.version })}</span>
          <button className="text-action" onClick={() => open(update.url)} type="button">{t("update.openPage")}</button>
          <button className="text-action" onClick={onDismissUpdate} title={t("update.dismiss")} type="button">{t("update.hide")}</button>
        </div>
      )}

      <p className="about-text">{t("about.description")}</p>
      <ul className="about-facts">
        <li>{t("about.factLocal")}</li>
        <li>{t("about.factOpenssh")}</li>
        <li>{t("about.factPrivacy")}</li>
      </ul>

      <div className="about-donate">
        <div>
          <h3>{t("about.donateTitle")}</h3>
          <p>{t("about.donateText")}</p>
        </div>
        <button className="button button-primary about-donate-button" onClick={() => open(SPONSOR_URL)} type="button"><span aria-hidden="true">♥</span> {t("about.donate")}</button>
      </div>
      <div className="form-footnote">{t("about.donateHint")}</div>

      {error && <div aria-live="polite" className="editor-notice">{error}</div>}
      <div className="editor-actions">
        <button className="button button-secondary" onClick={() => open(REPOSITORY_URL)} type="button">{t("about.github")}</button>
        <button autoFocus className="button button-secondary" onClick={onClose} type="button">{t("about.close")}</button>
      </div>
    </Dialog>
  );
}

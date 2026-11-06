import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import BrandMark from "./BrandMark";
import { t, translateBackend } from "./i18n";

export const REPOSITORY_URL = "https://github.com/alex-1987/Crabshell";
export const SPONSOR_URL = "https://github.com/sponsors/alex-1987";

type AboutDialogProps = {
  version: string;
  onClose: () => void;
};

/** About Crabshell. Donations only open GitHub Sponsors in the browser; no payment in the app. */
export default function AboutDialog({ version, onClose }: AboutDialogProps) {
  const [error, setError] = useState("");

  function open(url: string) {
    openUrl(url).catch((openError: unknown) => setError(t("about.openFailed", { error: translateBackend(openError) })));
  }

  return (
    <div className="dialog-scrim" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
      <section aria-labelledby="about-title" aria-modal="true" className="server-dialog about-dialog" role="dialog">
        <header className="dialog-heading">
          <div><div className="page-eyebrow">{t("about.eyebrow")}</div><h2 id="about-title">Crabshell</h2></div>
          <button aria-label={t("about.close")} className="icon-button" onClick={onClose} type="button">×</button>
        </header>

        <div className="about-brand">
          <BrandMark className="about-logo" size={72} />
          <div>
            <div className="about-version">{t("about.version", { version: version || "…" })}</div>
            <div className="about-tagline">{t("about.tagline")}</div>
          </div>
        </div>

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
      </section>
    </div>
  );
}

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { t, translateBackend } from "./i18n";

type Status = { appImage: boolean; installed: boolean; upToDate: boolean };

/**
 * AppImage only: adds Crabshell to the application menu (a .desktop file plus icons in
 * ~/.local/share). Desktops use that entry for the taskbar icon. Packages already ship one.
 */
export default function DesktopIntegration() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void invoke<Status>("desktop_integration_status").then(setStatus).catch(() => setStatus(null));
  }, []);

  if (!status?.appImage) return null;

  function run(command: "desktop_integration_install" | "desktop_integration_remove", done: string) {
    setBusy(true);
    setMessage("");
    invoke<Status>(command)
      .then((next) => {
        setStatus(next);
        setMessage(done);
      })
      .catch((error: unknown) => setMessage(t("desktop.failed", { error: translateBackend(error) })))
      .finally(() => setBusy(false));
  }

  const state = !status.installed ? t("desktop.notInstalled") : status.upToDate ? t("desktop.installed") : t("desktop.outdated");
  return (
    <>
      <h3>{t("desktop.title")}</h3>
      <div className="desktop-integration">
        <span className={`desktop-integration-state${status.installed && status.upToDate ? " desktop-integration-ok" : ""}`}>{state}</span>
        <div className="desktop-integration-actions">
          {(!status.installed || !status.upToDate) && (
            <button className="button button-secondary" disabled={busy} onClick={() => run("desktop_integration_install", t("desktop.installedNotice"))} type="button">
              {status.installed ? t("desktop.update") : t("desktop.install")}
            </button>
          )}
          {status.installed && (
            <button className="button button-secondary" disabled={busy} onClick={() => run("desktop_integration_remove", t("desktop.removedNotice"))} type="button">{t("desktop.remove")}</button>
          )}
        </div>
      </div>
      {message && <div aria-live="polite" className="form-footnote">{message}</div>}
      <div className="form-footnote">{t("desktop.hint")}</div>
    </>
  );
}

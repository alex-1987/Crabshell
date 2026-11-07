import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { useState, type FormEvent } from "react";
import Dialog from "./Dialog";
import { t, translateBackend } from "./i18n";
import { fileName } from "./labels";
import { serverCategories } from "./ServerList";
import type { AppSettings, SavedHost } from "./terminalTypes";

/** Result of `test_connection` (src-tauri/src/conntest.rs). */
type ConnectionTest = { address: string; port: number; banner: string; millis: number };

type ServerDialogProps = {
  /** Server to edit, or null for a new one. */
  server: SavedHost | null;
  /** Category of a new server (the active category filter). */
  initialCategory: string;
  servers: SavedHost[];
  settings: Pick<AppSettings, "appearances" | "defaultAppearanceId">;
  /** Storage problem that blocks saving; shown in the dialog. */
  storageError: string;
  onSave: (server: SavedHost) => Promise<void>;
  /**
   * "New connection" from the + menu: the main button connects without saving ("Connect
   * only"); saving also connects.
   */
  onConnect?: (server: SavedHost) => void;
  /** With onConnect: the save button also opens the connection ("Save and connect"). */
  saveConnects?: boolean;
  /** Opens Settings → Designs with the selected design ("" = default design). */
  onEditDesigns: (appearanceId: string) => void;
  onClose: () => void;
};

/** Add or edit a saved server. */
export default function ServerDialog({ server, initialCategory, servers, settings, storageError, onSave, onConnect, saveConnects = false, onEditDesigns, onClose }: ServerDialogProps) {
  const [label, setLabel] = useState(server?.label ?? "");
  const [host, setHost] = useState(server?.host ?? "");
  const [port, setPort] = useState(String(server?.port ?? 22));
  const [username, setUsername] = useState(server?.username ?? "");
  const [identityFile, setIdentityFile] = useState(server?.identityFile ?? "");
  const [appearanceId, setAppearanceId] = useState(server?.appearanceId ?? "");
  const [category, setCategory] = useState(server ? server.category : initialCategory);
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ state: "running" } | { state: "ok" | "failed"; text: string } | null>(null);
  const categories = serverCategories(servers);

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
      setNotice(t("notice.filePickerFailed", { error: translateBackend(error) }));
    }
  }

  /** The profile from the form, or null (with a notice) when host or port are invalid. */
  function profile(): SavedHost | null {
    const savedHost = host.trim();
    if (!savedHost) {
      setNotice(t("notice.enterHost"));
      return null;
    }
    const savedPort = Number(port.trim() || "22");
    if (!Number.isInteger(savedPort) || savedPort < 1 || savedPort > 65535) {
      setNotice(t("notice.invalidPort"));
      return null;
    }
    // Reuse the spelling of an existing category ("homelab" → "HomeLab").
    const typedCategory = category.trim().slice(0, 48);
    const savedCategory = categories.find((item) => item.localeCompare(typedCategory, undefined, { sensitivity: "base" }) === 0) ?? typedCategory;
    return {
      id: server?.id ?? crypto.randomUUID(),
      label: label.trim(),
      host: savedHost,
      port: savedPort,
      username: username.trim(),
      identityFile,
      // The design may have been deleted while this dialog was open.
      appearanceId: settings.appearances.some((item) => item.id === appearanceId) ? appearanceId : "",
      category: savedCategory,
    };
  }

  async function save() {
    const next = profile();
    if (!next) return;
    setSaving(true);
    try {
      await onSave(next);
    } finally {
      setSaving(false);
    }
  }

  function connect() {
    const next = profile();
    if (next) onConnect?.(next);
  }

  async function test() {
    const next = profile();
    if (!next) return;
    setNotice("");
    setTestResult({ state: "running" });
    try {
      const result = await invoke<ConnectionTest>("test_connection", { host: next.host, port: next.port, username: next.username || null });
      setTestResult({ state: "ok", text: t("server.testOk", { address: `${result.address}:${result.port}`, banner: result.banner.replace(/^SSH-[\d.]+-/, ""), millis: result.millis }) });
    } catch (error) {
      setTestResult({ state: "failed", text: translateBackend(error) });
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Enter: the main button of the dialog.
    if (onConnect) connect();
    else void save();
  }

  const defaultDesign = settings.appearances.find((item) => item.id === settings.defaultAppearanceId)?.name ?? "Crabshell";

  return (
    <Dialog closeLabel={t("server.closeDialog")} onClose={onClose} title={onConnect ? t("server.connectTitle") : server ? t("server.editTitle") : t("server.addTitle")} titleId="editor-title">
      <form className="editor-form" onSubmit={submit}>
        <label className="field-label" htmlFor="label">{t("server.label")}</label>
        <input autoComplete="off" autoFocus id="label" name="label" onChange={(event) => setLabel(event.target.value)} placeholder={t("server.labelPlaceholder")} value={label} />
        <label className="field-label" htmlFor="category">{t("server.category")}</label>
        <input autoComplete="off" id="category" list="server-categories" maxLength={48} name="category" onChange={(event) => setCategory(event.target.value)} placeholder={t("server.categoryPlaceholder")} value={category} />
        <datalist id="server-categories">{categories.map((item) => <option key={item} value={item} />)}</datalist>
        <label className="field-label" htmlFor="host">{t("server.host")}</label>
        <div className="host-port-row">
          <input autoComplete="off" id="host" name="host" onChange={(event) => setHost(event.target.value)} placeholder={t("server.hostPlaceholder")} spellCheck={false} value={host} required />
          <input aria-label={t("server.port")} autoComplete="off" className="port-input" id="port" inputMode="numeric" max={65535} min={1} name="port" onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))} placeholder="22" title={t("server.portHint")} type="text" value={port} />
        </div>
        <label className="field-label" htmlFor="username">{t("server.username")}</label>
        <input autoComplete="off" id="username" name="username" onChange={(event) => setUsername(event.target.value)} placeholder={t("server.usernamePlaceholder")} spellCheck={false} value={username} />
        <label className="field-label" htmlFor="identity-file">{t("server.privateKey")}</label>
        <div className="key-picker" title={t("server.footnote")}>
          <span className="key-picker-name" title={identityFile || undefined}>{identityFile ? fileName(identityFile) : t("server.noKey")}</span>
          <button className="button button-secondary key-picker-button" onClick={() => void choosePrivateKey()} type="button">{t("server.chooseFile")}</button>
          {identityFile && <button aria-label={t("server.removeKey")} className="button button-secondary key-picker-clear" onClick={() => setIdentityFile("")} title={t("server.removeKeyTitle")} type="button">×</button>}
        </div>
        <label className="field-label" htmlFor="appearance">{t("server.design")}</label>
        <div className="key-picker">
          <select id="appearance" onChange={(event) => setAppearanceId(event.target.value)} value={appearanceId}>
            <option value="">{t("server.defaultDesign", { name: defaultDesign })}</option>
            {settings.appearances.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button className="button button-secondary key-picker-button" onClick={() => onEditDesigns(appearanceId)} type="button">{t("server.editDesigns")}</button>
        </div>
        {(notice || storageError) && <div aria-live="polite" className="editor-notice">{notice || storageError}</div>}
        {testResult && (
          <div aria-live="polite" className={`connection-test connection-test-${testResult.state}`}>
            {testResult.state === "running" ? t("server.testRunning") : `${testResult.state === "ok" ? "✓" : "✗"} ${testResult.text}`}
          </div>
        )}
        <div className="editor-actions">
          <button className="button button-secondary" onClick={onClose} type="button">{t("common.cancel")}</button>
          <button className="button button-secondary editor-actions-start" disabled={testResult?.state === "running"} onClick={() => void test()} title={t("server.testTitle")} type="button">{t("server.test")}</button>
          {onConnect ? (
            <>
              <button className="button button-secondary" disabled={saving || Boolean(storageError)} onClick={() => void save()} type="button">{saveConnects ? t("server.saveAndConnect") : t("server.save")}</button>
              <button className="button button-primary" title={t("server.connectOnlyTitle")} type="submit">{t("server.connectOnly")}</button>
            </>
          ) : (
            <button className="button button-primary" disabled={saving || Boolean(storageError)} type="submit">{server ? t("server.saveChanges") : t("server.save")}</button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

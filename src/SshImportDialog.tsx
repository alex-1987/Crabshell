import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, type FormEvent } from "react";
import Dialog from "./Dialog";
import { t, translateBackend } from "./i18n";
import { serverCategories } from "./ServerList";
import type { SavedHost } from "./terminalTypes";

/** Result of `ssh_config_hosts` (src-tauri/src/sshconfig.rs). */
type SshConfigHost = { alias: string; hostname: string; user: string; port: number | null; proxied: boolean };

/** Same limit as MAX_SAVED_SERVERS in src-tauri/src/storage.rs. */
const MAX_SERVERS = 500;

type SshImportDialogProps = {
  servers: SavedHost[];
  /** Category for the imported servers (the active category filter). */
  initialCategory: string;
  /** Saves the new servers; false when writing failed (the dialog stays open). */
  onImport: (servers: SavedHost[]) => Promise<boolean>;
  onClose: () => void;
};

function sameAlias(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "base" }) === 0;
}

/** What OpenSSH will connect to, as far as the Host block says ("deploy@10.0.0.5:2222"). */
function hostDetails(host: SshConfigHost): string {
  const target = `${host.user ? `${host.user}@` : ""}${host.hostname || host.alias}${host.port ? `:${host.port}` : ""}`;
  return host.proxied ? `${target} · ${t("import.proxied")}` : target;
}

/**
 * Picks Host aliases from ~/.ssh/config and saves them as servers. Only the alias is stored,
 * so OpenSSH keeps reading HostName, User, Port, keys and ProxyJump from the config.
 */
export default function SshImportDialog({ servers, initialCategory, onImport, onClose }: SshImportDialogProps) {
  const [hosts, setHosts] = useState<SshConfigHost[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [category, setCategory] = useState(initialCategory);
  const [saving, setSaving] = useState(false);
  const categories = serverCategories(servers);
  const saved = (alias: string) => servers.some((server) => sameAlias(server.host, alias));

  useEffect(() => {
    let active = true;
    invoke<SshConfigHost[]>("ssh_config_hosts")
      .then((list) => {
        if (!active) return;
        setHosts(list);
        setSelected(new Set(list.filter((host) => !servers.some((server) => sameAlias(server.host, host.alias))).map((host) => host.alias)));
      })
      .catch((error: unknown) => { if (active) setLoadError(translateBackend(error)); });
    return () => { active = false; };
    // Read the config once per opening; later changes to the server list do not reload it.
  }, []);

  const available = hosts?.filter((host) => !saved(host.alias)) ?? [];
  const allSelected = available.length > 0 && available.every((host) => selected.has(host.alias));
  const tooMany = servers.length + selected.size > MAX_SERVERS;

  function toggle(alias: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(alias);
    else next.delete(alias);
    setSelected(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hosts || selected.size === 0 || tooMany) return;
    // Reuse the spelling of an existing category ("homelab" → "HomeLab").
    const typedCategory = category.trim().slice(0, 48);
    const savedCategory = categories.find((item) => sameAlias(item, typedCategory)) ?? typedCategory;
    const imported = hosts
      .filter((host) => selected.has(host.alias) && !saved(host.alias))
      .map((host): SavedHost => ({
        id: crypto.randomUUID(),
        label: "",
        host: host.alias,
        port: 22,
        username: "",
        identityFile: "",
        appearanceId: "",
        category: savedCategory,
      }));
    setSaving(true);
    try {
      if (await onImport(imported)) onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog closeLabel={t("import.close")} onClose={onClose} title={t("import.title")} titleId="import-title">
      <form className="editor-form" onSubmit={(event) => void submit(event)}>
        <div className="form-footnote">{t("import.intro")}</div>
        {loadError ? (
          <div aria-live="polite" className="editor-notice">{loadError}</div>
        ) : !hosts ? (
          <div className="sidebar-empty">{t("import.loading")}</div>
        ) : hosts.length === 0 ? (
          <div className="sidebar-empty">{t("import.none")}</div>
        ) : (
          <>
            <div className="import-list-heading">
              <span>{t("import.count", { count: hosts.length })}</span>
              {available.length > 0 && (
                <button className="text-action" onClick={() => setSelected(allSelected ? new Set() : new Set(available.map((host) => host.alias)))} type="button">
                  {allSelected ? t("import.selectNone") : t("import.selectAll")}
                </button>
              )}
            </div>
            <div className="import-list" role="group" aria-label={t("import.title")}>
              {hosts.map((host) => {
                const exists = saved(host.alias);
                return (
                  <label className={`import-row${exists ? " import-row-saved" : ""}`} key={host.alias}>
                    <input checked={!exists && selected.has(host.alias)} disabled={exists} onChange={(event) => toggle(host.alias, event.target.checked)} type="checkbox" />
                    <span className="import-row-alias">{host.alias}</span>
                    <span className="import-row-details">{exists ? t("import.alreadySaved") : hostDetails(host)}</span>
                  </label>
                );
              })}
            </div>
            <label className="field-label" htmlFor="import-category">{t("server.category")}</label>
            <input autoComplete="off" id="import-category" list="import-categories" maxLength={48} onChange={(event) => setCategory(event.target.value)} placeholder={t("server.categoryPlaceholder")} value={category} />
            <datalist id="import-categories">{categories.map((item) => <option key={item} value={item} />)}</datalist>
            {tooMany && <div aria-live="polite" className="editor-notice">{t("import.tooMany", { max: MAX_SERVERS })}</div>}
          </>
        )}
        <div className="editor-actions">
          <button className="button button-secondary" onClick={onClose} type="button">{t("common.cancel")}</button>
          <button className="button button-primary" disabled={saving || selected.size === 0 || tooMany} type="submit">
            {t("import.submit", { count: selected.size })}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

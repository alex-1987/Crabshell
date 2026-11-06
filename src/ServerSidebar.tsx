import { useState } from "react";
import BrandMark from "./BrandMark";
import { t } from "./i18n";
import { fileName, serverAddress } from "./labels";
import ServerList from "./ServerList";
import type { SavedHost } from "./terminalTypes";

/** Sidebar filter state that survives hiding the sidebar. */
export type ServerFilters = {
  /** One category, "" for servers without one, or null for all. */
  category: string | null;
  query: string;
  collapsedGroups: ReadonlySet<string>;
};

type ServerSidebarProps = {
  servers: SavedHost[];
  storageReady: boolean;
  storageError: string;
  notice: string;
  filters: ServerFilters;
  doubleClick: boolean;
  onFilters: (filters: ServerFilters) => void;
  onHide: () => void;
  onAdd: () => void;
  onEdit: (server: SavedHost) => void;
  onOpen: (server: SavedHost) => void;
  onRemove: (id: string) => Promise<void>;
};

/** Left-hand server list with search, categories and the OpenSSH note. */
export default function ServerSidebar({ servers, storageReady, storageError, notice, filters, doubleClick, onFilters, onHide, onAdd, onEdit, onOpen, onRemove }: ServerSidebarProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const usable = storageReady && !storageError;
  const setQuery = (query: string) => onFilters({ ...filters, query });

  return (
    <aside className="sidebar" id="server-sidebar">
      <div className="sidebar-brand-row">
        <div className="brand-row">
          <BrandMark />
          <div><div className="brand-name">crabshell</div><div className="brand-caption">LOCAL SSH WORKSPACE</div></div>
        </div>
        <button aria-label={t("sidebar.hide")} className="icon-button sidebar-toggle" disabled={!storageReady} onClick={onHide} title={t("sidebar.hide")} type="button"><span aria-hidden="true">‹</span></button>
      </div>
      <div className="privacy-line"><span className="privacy-indicator" /><span>{t("sidebar.privacy")}</span></div>
      <div className="server-list-heading">
        <div><h1>{t("sidebar.servers")}</h1><span>{servers.length}</span></div>
        <button aria-label={t("sidebar.addServer")} className="icon-button add-server-button" disabled={!usable} onClick={onAdd} title={t("sidebar.addServer")} type="button"><span aria-hidden="true">+</span></button>
      </div>
      {notice && <div aria-live="polite" className="page-notice">{notice}</div>}
      {usable && servers.length > 0 && (
        <div className="sidebar-search">
          <span aria-hidden="true" className="sidebar-search-icon">⌕</span>
          <input
            aria-label={t("sidebar.search")}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filters.query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }}
            placeholder={t("sidebar.search")}
            spellCheck={false}
            type="search"
            value={filters.query}
          />
          {filters.query && <button aria-label={t("sidebar.clearSearch")} className="sidebar-search-clear" onClick={() => setQuery("")} title={t("sidebar.clearSearch")} type="button">×</button>}
        </div>
      )}
      <nav aria-label={t("sidebar.savedServers")} className="saved-server-list">
        {!storageReady ? <div className="sidebar-empty">{t("sidebar.loading")}</div> : storageError ? <div aria-live="polite" className="sidebar-storage-error">{storageError}</div> : servers.length === 0 ? <div className="sidebar-empty">{t("sidebar.empty")}</div> : (
          <ServerList
            activeCategory={filters.category}
            address={serverAddress}
            collapsed={filters.collapsedGroups}
            confirmDeleteId={confirmDeleteId}
            disabled={!usable}
            doubleClick={doubleClick}
            keyName={fileName}
            onCategory={(category) => onFilters({ ...filters, category })}
            onConfirmDelete={setConfirmDeleteId}
            onEdit={onEdit}
            onOpen={onOpen}
            onRemove={(id) => void onRemove(id).then(() => setConfirmDeleteId(null))}
            onToggleGroup={(key) => {
              const collapsedGroups = new Set(filters.collapsedGroups);
              if (!collapsedGroups.delete(key)) collapsedGroups.add(key);
              onFilters({ ...filters, collapsedGroups });
            }}
            query={filters.query}
            servers={servers}
          />
        )}
      </nav>
      <div className="sidebar-bottom">
        <div className="open-ssh-badge"><span>SSH</span><div><strong>OpenSSH</strong><small>{t("sidebar.systemInstall")}</small></div></div>
        <div className="sidebar-meta">{t("sidebar.meta")}</div>
      </div>
    </aside>
  );
}

import { useState } from "react";
import BrandMark from "./BrandMark";
import { t } from "./i18n";
import { fileName, serverAddress, withShortcut } from "./labels";
import ServerList, { type ServerListProps } from "./ServerList";
import { terminalStore } from "./terminalStore";
import type { SavedHost } from "./terminalTypes";

/** Sidebar filter state that survives hiding the sidebar. */
export type ServerFilters = {
  /** One category, "" for servers without one, or null for all. */
  category: string | null;
  query: string;
  collapsedGroups: ReadonlySet<string>;
};

type ServerSidebarProps = {
  /** App version shown next to the name ("" while loading). */
  version: string;
  servers: SavedHost[];
  storageReady: boolean;
  storageError: string;
  notice: string;
  filters: ServerFilters;
  doubleClick: boolean;
  onFilters: (filters: ServerFilters) => void;
  onHide: () => void;
  onAdd: () => void;
  /** Opens the import from ~/.ssh/config. */
  onImport: () => void;
  onEdit: (server: SavedHost) => void;
  onOpen: (server: SavedHost) => void;
  onRemove: (id: string) => Promise<void>;
  /** Color of the bar on the left of a server ("" for none). */
  markerColor: (server: SavedHost) => string;
  categoryOrder: readonly string[];
  onMoveServer: ServerListProps["onMoveServer"];
  onReorderCategory: ServerListProps["onReorderCategory"];
};

/** Left-hand server list with search, categories and the OpenSSH note. */
export default function ServerSidebar({ version, servers, storageReady, storageError, notice, filters, doubleClick, onFilters, onHide, onAdd, onImport, onEdit, onOpen, onRemove, markerColor, categoryOrder, onMoveServer, onReorderCategory }: ServerSidebarProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const usable = storageReady && !storageError;
  const hideLabel = withShortcut(t("sidebar.hide"), terminalStore.shortcutLabel("toggleSidebar"));
  const setQuery = (query: string) => onFilters({ ...filters, query });

  return (
    <aside className="sidebar" id="server-sidebar">
      <div className="sidebar-brand-row" title={`Crabshell ${version}`}>
        <BrandMark size={16} />
        <span className="brand-name">crabshell</span>
        {version && <span className="brand-version">{version}</span>}
      </div>
      <div className="server-list-heading">
        <div><h1>{t("sidebar.servers")}</h1><span>{servers.length}</span></div>
        <div className="sidebar-heading-actions">
          <button aria-label={t("sidebar.importSshConfig")} className="icon-button" disabled={!usable} onClick={onImport} title={t("sidebar.importSshConfig")} type="button"><span aria-hidden="true">⤓</span></button>
          <button aria-label={t("sidebar.addServer")} className="icon-button" disabled={!usable} onClick={onAdd} title={t("sidebar.addServer")} type="button"><span aria-hidden="true">+</span></button>
          <button aria-label={hideLabel} className="icon-button" disabled={!storageReady} onClick={onHide} title={hideLabel} type="button"><span aria-hidden="true">‹</span></button>
        </div>
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
        {!storageReady ? <div className="sidebar-empty">{t("sidebar.loading")}</div> : storageError ? <div aria-live="polite" className="sidebar-storage-error">{storageError}</div> : servers.length === 0 ? (
          <div className="sidebar-empty">
            {t("sidebar.empty")}
            <button className="text-action sidebar-empty-action" onClick={onImport} type="button">{t("sidebar.importSshConfig")}</button>
          </div>
        ) : (
          <ServerList
            activeCategory={filters.category}
            address={serverAddress}
            collapsed={filters.collapsedGroups}
            confirmDeleteId={confirmDeleteId}
            disabled={!usable}
            doubleClick={doubleClick}
            keyName={fileName}
            markerColor={markerColor}
            categoryOrder={categoryOrder}
            onMoveServer={onMoveServer}
            onReorderCategory={onReorderCategory}
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
    </aside>
  );
}

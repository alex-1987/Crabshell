import FilterChips, { type FilterChip } from "./FilterChips";
import { t } from "./i18n";
import type { SavedHost } from "./terminalTypes";

/** Key used for servers without a category (categories are trimmed, so it never collides). */
const UNCATEGORIZED = " ";

type Group = { key: string; label: string; servers: SavedHost[] };

/** Groups servers by category: named categories alphabetically, servers without one last. Order inside a group is kept. */
function groupServers(servers: SavedHost[]): Group[] {
  const groups = new Map<string, Group>();
  for (const server of servers) {
    const key = server.category || UNCATEGORIZED;
    let group = groups.get(key);
    if (!group) {
      group = { key, label: server.category || t("sidebar.uncategorized"), servers: [] };
      groups.set(key, group);
    }
    group.servers.push(server);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === UNCATEGORIZED) return 1;
    if (b.key === UNCATEGORIZED) return -1;
    return a.key.localeCompare(b.key, undefined, { sensitivity: "base" });
  });
}

/** Case-insensitive match on label, host, user, port and category; every word must match. */
export function matchesServer(server: SavedHost, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [server.label, server.host, server.username, String(server.port), server.category].join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Existing categories, for the editor's suggestions and to reuse their spelling. */
export function serverCategories(servers: SavedHost[]): string[] {
  return groupServers(servers).filter((group) => group.key !== UNCATEGORIZED).map((group) => group.key);
}

type ServerListProps = {
  servers: SavedHost[];
  disabled: boolean;
  doubleClick: boolean;
  /** Search text; empty shows all servers. */
  query: string;
  activeCategory: string | null;
  onCategory: (category: string | null) => void;
  collapsed: ReadonlySet<string>;
  onToggleGroup: (category: string) => void;
  confirmDeleteId: string | null;
  onConfirmDelete: (id: string | null) => void;
  onOpen: (server: SavedHost) => void;
  onEdit: (server: SavedHost) => void;
  onRemove: (id: string) => void;
  address: (server: SavedHost) => string;
  keyName: (path: string) => string;
};

/** Saved servers, grouped by category, with chips to show only one category. */
export default function ServerList(props: ServerListProps) {
  const { servers, disabled, doubleClick, query, activeCategory, onCategory, collapsed, onToggleGroup } = props;
  const searching = query.trim() !== "";
  // Chips come from all servers so they do not jump around while typing; counts show the matches.
  const allGroups = groupServers(servers);
  const groups = allGroups
    .map((group) => ({ ...group, servers: group.servers.filter((server) => matchesServer(server, query)) }));
  const hasCategories = allGroups.some((group) => group.key !== UNCATEGORIZED);
  // A filter for a category that no longer exists shows everything again.
  const active = activeCategory !== null && allGroups.some((group) => group.key === activeCategory) ? activeCategory : null;
  const visible = groups.filter((group) => group.servers.length > 0 && (active === null || group.key === active));
  const chips: FilterChip[] = hasCategories ? groups.map((group) => ({ key: group.key, label: group.label, count: group.servers.length })) : [];

  return (
    <>
      <FilterChips active={active} chips={chips} label={t("sidebar.categoryFilter")} onChange={onCategory} />
      {visible.length === 0 && <div className="sidebar-empty">{t("sidebar.noMatches")}</div>}
      {visible.map((group) => {
        // While filtering or searching, matching groups are always expanded.
        const isCollapsed = active === null && !searching && collapsed.has(group.key);
        return (
          <div className="server-group" key={group.key} role="group" aria-label={group.label}>
            {hasCategories && active === null && !searching && (
              <button aria-expanded={!isCollapsed} className="server-group-heading" onClick={() => onToggleGroup(group.key)} title={t("sidebar.groupToggle", { name: group.label })} type="button">
                <span aria-hidden="true" className="server-group-caret">{isCollapsed ? "▸" : "▾"}</span>
                <span className="server-group-name">{group.label}</span>
                <span className="server-group-count">{group.servers.length}</span>
              </button>
            )}
            {!isCollapsed && group.servers.map((server) => <ServerRow {...props} disabled={disabled} doubleClick={doubleClick} key={server.id} server={server} />)}
          </div>
        );
      })}
    </>
  );
}

function ServerRow({ server, disabled, doubleClick, confirmDeleteId, onConfirmDelete, onOpen, onEdit, onRemove, address, keyName }: ServerListProps & { server: SavedHost }) {
  const name = server.label || server.host;
  return (
    <div className="saved-server">
      <button
        className="saved-server-main"
        disabled={disabled}
        // event.detail is 0 for keyboard activation, which always opens.
        onClick={(event) => { if (!doubleClick || event.detail === 0) onOpen(server); }}
        onDoubleClick={() => { if (doubleClick) onOpen(server); }}
        title={doubleClick ? t("sidebar.openDouble", { address: address(server) }) : address(server)}
        type="button"
      >
        <span className="saved-server-name">{name}</span>
        <span className="saved-server-host">{address(server)}</span>
        {server.identityFile && <span className="saved-server-key">{t("sidebar.key", { file: keyName(server.identityFile) })}</span>}
      </button>
      {confirmDeleteId === server.id ? (
        <div className="sidebar-delete-confirm" role="group" aria-label={t("sidebar.removeGroup", { name })}>
          <button className="text-action" onClick={() => onConfirmDelete(null)} type="button">{t("common.cancel")}</button>
          <button className="text-action text-danger" onClick={() => onRemove(server.id)} type="button">{t("sidebar.remove")}</button>
        </div>
      ) : (
        <div className="saved-server-actions">
          <button aria-label={t("sidebar.editServer", { name })} className="icon-button row-icon-button" onClick={() => onEdit(server)} title={t("sidebar.edit")} type="button"><span aria-hidden="true">✎</span></button>
          <button aria-label={t("sidebar.deleteServer", { name })} className="icon-button row-icon-button" onClick={() => onConfirmDelete(server.id)} title={t("sidebar.delete")} type="button"><span aria-hidden="true">×</span></button>
        </div>
      )}
    </div>
  );
}

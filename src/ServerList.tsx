import FilterChips, { type FilterChip } from "./FilterChips";
import { t } from "./i18n";
import type { SavedHost } from "./terminalTypes";
import { byOrder, useListDrag } from "./useListDrag";

/** Key used for servers without a category (categories are trimmed, so it never collides). */
const UNCATEGORIZED = " ";

type Group = { key: string; label: string; servers: SavedHost[] };

/** Drop key of a group heading for servers: "group:" plus the category ("" for none). */
const GROUP_PREFIX = "group:";

/**
 * Groups servers by category: named categories in `order` (set by dragging), the rest
 * alphabetically, servers without one last. Order inside a group is kept.
 */
function groupServers(servers: SavedHost[], order: readonly string[] = []): Group[] {
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
  const named = [...groups.values()].filter((group) => group.key !== UNCATEGORIZED);
  const sorted = byOrder(named, (group) => group.key, order, (a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: "base" }));
  const uncategorized = groups.get(UNCATEGORIZED);
  return uncategorized ? [...sorted, uncategorized] : sorted;
}

/** Case-insensitive match on label, host, user, port and category; every word must match. */
export function matchesServer(server: SavedHost, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [server.label, server.host, server.username, String(server.port), server.category].join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Existing categories in display order, for the editor's suggestions and to reuse their spelling. */
export function serverCategories(servers: SavedHost[], order: readonly string[] = []): string[] {
  return groupServers(servers, order).filter((group) => group.key !== UNCATEGORIZED).map((group) => group.key);
}

export type ServerListProps = {
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
  /** Color of the bar on the left of a server ("" for none). */
  markerColor: (server: SavedHost) => string;
  /** Category order from the settings. */
  categoryOrder: readonly string[];
  /** Drag and drop: `target` is a server id, or a group heading (then the server goes to the end of that category). */
  onMoveServer: (id: string, target: { serverId: string; after: boolean } | { category: string }) => void;
  /** Drag and drop of a category (heading or chip) before or after another one. */
  onReorderCategory: (source: string, target: string, after: boolean) => void;
};

/** Saved servers, grouped by category, with chips to show only one category. */
export default function ServerList(props: ServerListProps) {
  const { servers, disabled, doubleClick, query, activeCategory, onCategory, collapsed, onToggleGroup, categoryOrder, onMoveServer, onReorderCategory } = props;
  const searching = query.trim() !== "";
  // Chips come from all servers so they do not jump around while typing; counts show the matches.
  const allGroups = groupServers(servers, categoryOrder);
  const groups = allGroups
    .map((group) => ({ ...group, servers: group.servers.filter((server) => matchesServer(server, query)) }));
  const hasCategories = allGroups.some((group) => group.key !== UNCATEGORIZED);
  // A filter for a category that no longer exists shows everything again.
  const active = activeCategory !== null && allGroups.some((group) => group.key === activeCategory) ? activeCategory : null;
  const visible = groups.filter((group) => group.servers.length > 0 && (active === null || group.key === active));
  const chips: FilterChip[] = hasCategories ? groups.map((group) => ({ key: group.key, label: group.label, count: group.servers.length, fixed: group.key === UNCATEGORIZED })) : [];

  const serverDrag = useListDrag({
    scope: "server",
    axis: "y",
    label: (id) => {
      const server = servers.find((item) => item.id === id);
      return server ? server.label || server.host : id;
    },
    onDrop: (id, target, after) => onMoveServer(id, target.startsWith(GROUP_PREFIX) ? { category: target.slice(GROUP_PREFIX.length) } : { serverId: target, after }),
    disabled,
  });
  const categoryDrag = useListDrag({
    scope: "category",
    axis: "y",
    label: (key) => key,
    onDrop: onReorderCategory,
    disabled,
  });

  return (
    <>
      <FilterChips active={active} chips={chips} label={t("sidebar.categoryFilter")} onChange={onCategory} onReorder={disabled ? undefined : onReorderCategory} />
      {visible.length === 0 && <div className="sidebar-empty">{t("sidebar.noMatches")}</div>}
      {visible.map((group) => {
        // While filtering or searching, matching groups are always expanded.
        const isCollapsed = active === null && !searching && collapsed.has(group.key);
        return (
          <div className="server-group" key={group.key} role="group" aria-label={group.label}>
            {hasCategories && active === null && !searching && (
              <button
                aria-expanded={!isCollapsed}
                className={`server-group-heading${categoryDrag.draggingKey === group.key ? " list-drag-source" : ""}`}
                onClick={() => onToggleGroup(group.key)}
                title={`${t("sidebar.groupToggle", { name: group.label })}${group.key === UNCATEGORIZED ? "" : `\n${t("drag.reorderHint")}`}`}
                type="button"
                {...serverDrag.targetProps(GROUP_PREFIX + (group.key === UNCATEGORIZED ? "" : group.key))}
                {...(group.key === UNCATEGORIZED ? {} : categoryDrag.itemProps(group.key))}
              >
                <span aria-hidden="true" className="server-group-caret">{isCollapsed ? "▸" : "▾"}</span>
                <span className="server-group-name">{group.label}</span>
                <span className="server-group-count">{group.servers.length}</span>
              </button>
            )}
            {!isCollapsed && group.servers.map((server) => <ServerRow {...props} disabled={disabled} doubleClick={doubleClick} dragProps={serverDrag.itemProps(server.id)} dragging={serverDrag.draggingKey === server.id} key={server.id} server={server} />)}
          </div>
        );
      })}
      {serverDrag.overlay}
      {categoryDrag.overlay}
    </>
  );
}

type ServerRowProps = ServerListProps & { server: SavedHost; dragProps: Record<string, unknown>; dragging: boolean };

function ServerRow({ server, disabled, doubleClick, confirmDeleteId, onConfirmDelete, onOpen, onEdit, onRemove, address, keyName, markerColor, dragProps, dragging }: ServerRowProps) {
  const name = server.label || server.host;
  const marker = markerColor(server);
  return (
    <div className={`saved-server${dragging ? " list-drag-source" : ""}`} style={marker ? { borderLeftColor: marker } : undefined} {...dragProps}>
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

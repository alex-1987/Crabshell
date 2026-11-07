import { useState, type KeyboardEvent } from "react";
import { t } from "./i18n";
import { matchesServer } from "./ServerList";
import type { SavedHost, SplitTarget } from "./terminalTypes";
import { useFloatingMenu } from "./useFloatingMenu";

type TargetMenuProps = {
  title: string;
  x: number;
  y: number;
  /** "Same as now" entry (split menu only): title of the active pane and the split shortcut. */
  same?: { label: string; shortcut: string };
  /** Shortcut shown next to "Local shell". */
  localShortcut?: string;
  /** "New connection …" entry (new tab menu): opens the dialog for a server that is not saved. */
  onNewConnection?: () => void;
  servers: SavedHost[];
  serverAddress: (server: SavedHost) => string;
  onChoose: (target: SplitTarget) => void;
  onClose: () => void;
};

/**
 * Chooses what a new tab or a new split pane runs: (the same target as now,) a local shell or
 * one of the saved servers, with a search field when there are many servers.
 */
export default function TargetMenu({ title, x, y, same, localShortcut, onNewConnection, servers, serverAddress, onChoose, onClose }: TargetMenuProps) {
  const [query, setQuery] = useState("");
  const showSearch = servers.length > 6;
  const { ref, position, handleMenuKey } = useFloatingMenu({ x, y, onClose, focusSelector: showSearch ? "input" : "button" });
  const matches = servers.filter((server) => matchesServer(server, query));

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (handleMenuKey(event)) return;
    // Enter in the search field opens the first match.
    if (event.key === "Enter" && event.target instanceof HTMLInputElement && matches[0]) {
      event.preventDefault();
      onChoose({ kind: "server", server: matches[0] });
    }
  }

  return (
    <div aria-label={title} className="context-menu split-menu" onContextMenu={(event) => event.preventDefault()} onKeyDown={handleKey} ref={ref} role="menu" style={position}>
      <div className="split-menu-title">{title}</div>
      {same && (
        <button className="context-menu-item" onClick={() => onChoose({ kind: "same" })} role="menuitem" type="button">
          <span className="split-menu-label">{t("split.same", { name: same.label })}</span>
          {same.shortcut && <kbd>{same.shortcut}</kbd>}
        </button>
      )}
      <button className="context-menu-item" onClick={() => onChoose({ kind: "local" })} role="menuitem" type="button">
        <span className="split-menu-label">{t("split.local")}</span>
        {localShortcut && <kbd>{localShortcut}</kbd>}
      </button>
      {onNewConnection && (
        <button className="context-menu-item" onClick={onNewConnection} role="menuitem" type="button">
          <span className="split-menu-label">{t("tabs.newConnection")}</span>
        </button>
      )}
      {servers.length > 0 && <div className="split-menu-title split-menu-section">{t("split.servers")}</div>}
      {showSearch && (
        <input aria-label={t("sidebar.search")} autoComplete="off" className="split-menu-search" onChange={(event) => setQuery(event.target.value)} placeholder={t("sidebar.search")} spellCheck={false} value={query} />
      )}
      <div className="split-menu-servers">
        {matches.map((server) => (
          <button className="context-menu-item" key={server.id} onClick={() => onChoose({ kind: "server", server })} role="menuitem" title={serverAddress(server)} type="button">
            <span className="split-menu-label">{server.label || server.host}</span>
            {server.category && <span className="split-menu-category">{server.category}</span>}
          </button>
        ))}
        {showSearch && matches.length === 0 && <div className="sidebar-empty">{t("sidebar.noMatches")}</div>}
      </div>
    </div>
  );
}

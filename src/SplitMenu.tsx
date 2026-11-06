import { useState, type KeyboardEvent } from "react";
import { t } from "./i18n";
import { matchesServer } from "./ServerList";
import { terminalStore } from "./terminalStore";
import type { SavedHost, SplitDirection, SplitTarget } from "./terminalTypes";
import { useFloatingMenu } from "./useFloatingMenu";

type SplitMenuProps = {
  direction: SplitDirection;
  x: number;
  y: number;
  /** Title of the active pane, for the "same session" entry. */
  sameLabel: string;
  servers: SavedHost[];
  serverAddress: (server: SavedHost) => string;
  onChoose: (target: SplitTarget) => void;
  onClose: () => void;
};

/** Chooses what the new split pane runs: the same session target, a local shell or a saved server. */
export default function SplitMenu({ direction, x, y, sameLabel, servers, serverAddress, onChoose, onClose }: SplitMenuProps) {
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
    <div aria-label={direction === "row" ? t("split.menuRow") : t("split.menuColumn")} className="context-menu split-menu" onContextMenu={(event) => event.preventDefault()} onKeyDown={handleKey} ref={ref} role="menu" style={position}>
      <div className="split-menu-title">{direction === "row" ? t("split.menuRow") : t("split.menuColumn")}</div>
      <button className="context-menu-item" onClick={() => onChoose({ kind: "same" })} role="menuitem" type="button">
        <span className="split-menu-label">{t("split.same", { name: sameLabel })}</span>
        {terminalStore.shortcutLabel(direction === "row" ? "splitRight" : "splitDown") && <kbd>{terminalStore.shortcutLabel(direction === "row" ? "splitRight" : "splitDown")}</kbd>}
      </button>
      <button className="context-menu-item" onClick={() => onChoose({ kind: "local" })} role="menuitem" type="button">
        <span className="split-menu-label">{t("split.local")}</span>
      </button>
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

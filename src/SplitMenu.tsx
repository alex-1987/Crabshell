import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { t } from "./i18n";
import { matchesServer } from "./ServerList";
import { terminalStore } from "./terminalStore";
import type { SavedHost, SplitDirection, SplitTarget } from "./terminalTypes";

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
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [query, setQuery] = useState("");
  const showSearch = servers.length > 6;
  const matches = servers.filter((server) => matchesServer(server, query));

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
    element.querySelector<HTMLElement>(showSearch ? "input" : "button")?.focus();
    // Only positioned once; the list may shrink while searching.
  }, [x, y, showSearch]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    } else if (event.key === "Enter" && event.target instanceof HTMLInputElement && matches[0]) {
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

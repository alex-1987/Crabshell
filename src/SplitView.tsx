import { Fragment, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { t } from "./i18n";
import { NO_TAB_COLOR } from "./labels";
import TerminalPane from "./TerminalPane";
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO, terminalStore } from "./terminalStore";
import type { SessionStatus, TerminalPaneState, TerminalTab } from "./terminalTypes";

type SplitViewProps = {
  tab: TerminalTab;
  paneTitle: (pane: TerminalPaneState) => string;
  statusLabel: (status: SessionStatus) => string;
};

/**
 * Messages inside a pane instead of a status bar: an ended or failed session shows its message
 * with a restart/reconnect button; other notices (e.g. "copied to the clipboard") fade out.
 */
function PaneOverlay({ pane, statusLabel }: { pane: TerminalPaneState; statusLabel: (status: SessionStatus) => string }) {
  if (pane.reconnectAt > 0) return <ReconnectOverlay pane={pane} />;
  // A pane that has not started yet is also "disconnected", but without a message: no overlay.
  const ended = pane.status === "failed" || (pane.status === "disconnected" && pane.notice !== "");
  if (ended) {
    const action = pane.kind === "local" ? t("topbar.restart") : t("topbar.reconnect");
    return (
      <div className={`pane-overlay pane-overlay-ended${pane.status === "failed" ? " pane-overlay-failed" : ""}`} role="status">
        <span className="pane-overlay-text">{pane.notice || statusLabel(pane.status)}</span>
        <button className="pane-overlay-button" onClick={() => void terminalStore.connectPane(pane.id)} title={action} type="button">↻ {action}</button>
      </div>
    );
  }
  // Keyed by the text, so the same message shown again restarts the fade-out.
  return pane.notice ? <div aria-live="polite" className="pane-overlay pane-toast" key={pane.notice}>{pane.notice}</div> : null;
}

/** Lost connection: countdown to the automatic reconnect, with "Now" and "Cancel". */
function ReconnectOverlay({ pane }: { pane: TerminalPaneState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((pane.reconnectAt - now) / 1000));
  return (
    <div className="pane-overlay pane-overlay-ended" role="status">
      <span className="pane-overlay-text">
        {t("reconnect.countdown", { seconds })}
        {pane.reconnectAttempt > 1 && ` · ${t("reconnect.attempt", { attempt: pane.reconnectAttempt })}`}
      </span>
      <button className="pane-overlay-button" onClick={() => terminalStore.reconnectNow(pane.id)} type="button">↻ {t("reconnect.now")}</button>
      <button className="pane-overlay-button" onClick={() => terminalStore.cancelReconnect(pane.id)} type="button">{t("common.cancel")}</button>
    </div>
  );
}

/** The terminal area of a tab: one pane, or two panes side by side / stacked with a draggable divider. */
export default function SplitView({ tab, paneTitle, statusLabel }: SplitViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const split = tab.panes.length > 1 ? tab.split ?? "row" : null;
  const ratio = split ? tab.splitRatio : 1;

  function ratioAt(event: PointerEvent<HTMLDivElement>): number {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return tab.splitRatio;
    return split === "column" ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width;
  }

  function onDividerKey(event: KeyboardEvent<HTMLDivElement>) {
    const back = split === "column" ? "ArrowUp" : "ArrowLeft";
    const forward = split === "column" ? "ArrowDown" : "ArrowRight";
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    terminalStore.setSplitRatio(tab.id, tab.splitRatio + (event.key === forward ? 0.05 : -0.05));
  }

  return (
    <div className={`terminal-split${split ? ` terminal-split-${split}` : ""}${tab.broadcast ? " terminal-split-broadcast" : ""}`} data-split-tab={tab.id} ref={containerRef}>
      {tab.panes.map((pane, index) => {
        const active = split !== null && pane.id === tab.activePaneId;
        return (
          // Keyed by pane id, so splitting or closing never remounts a pane's terminal element.
          <Fragment key={pane.id}>
            {index === 1 && (
              <div
                aria-label={t("split.resize")}
                aria-orientation={split === "column" ? "horizontal" : "vertical"}
                aria-valuemax={MAX_SPLIT_RATIO * 100}
                aria-valuemin={MIN_SPLIT_RATIO * 100}
                aria-valuenow={Math.round(tab.splitRatio * 100)}
                className="split-divider"
                onDoubleClick={() => terminalStore.setSplitRatio(tab.id, 0.5)}
                onKeyDown={onDividerKey}
                onLostPointerCapture={() => { draggingRef.current = false; }}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  draggingRef.current = true;
                  event.preventDefault();
                }}
                onPointerMove={(event) => { if (draggingRef.current) terminalStore.setSplitRatio(tab.id, ratioAt(event)); }}
                onPointerUp={() => { draggingRef.current = false; }}
                role="separator"
                tabIndex={0}
                title={t("split.resizeHint")}
              />
            )}
            <div
              className={`terminal-pane-box${active ? " terminal-pane-active" : ""}`}
              data-pane-id={pane.id}
              data-pane-kind={pane.kind}
              style={{ flex: `${index === 0 ? ratio : 1 - ratio} 1 0`, "--terminal-bg": pane.appearance.background, // The active pane keeps its marker line even when the tab has no color.
              "--tab-color": (tab.customColor !== NO_TAB_COLOR && tab.customColor) || pane.appearance.tabColor } as CSSProperties}
            >
              {split && (
                // Small bar in the corner, only visible while hovering the pane.
                <div className="pane-header" onMouseDown={() => terminalStore.focusPane(pane.id, true)}>
                  <span className={`status-led status-${pane.status}`} title={statusLabel(pane.status)} />
                  <span className="pane-header-title" title={paneTitle(pane)}>{paneTitle(pane)}</span>
                  <button aria-label={t("split.detach", { name: paneTitle(pane) })} className="pane-header-button" onClick={() => terminalStore.detachPane(pane.id)} title={t("split.detachTitle")} type="button">⇱</button>
                  <button aria-label={t("split.closePane", { name: paneTitle(pane) })} className="pane-header-button pane-header-close" onClick={() => void terminalStore.closePane(pane.id)} title={terminalStore.shortcutLabel("close") ? `${t("split.closePaneTitle")} (${terminalStore.shortcutLabel("close")})` : t("split.closePaneTitle")} type="button">×</button>
                </div>
              )}
              <div className="terminal-body"><TerminalPane tabId={tab.id} paneId={pane.id} /></div>
              <PaneOverlay pane={pane} statusLabel={statusLabel} />
              {tab.broadcast && (
                <div className="pane-broadcast-badge" role="status">
                  <span>⇶ {t("broadcast.badge", { count: tab.panes.length })}</span>
                  <button onClick={() => terminalStore.toggleBroadcast(tab.id)} type="button">{t("broadcast.end")}</button>
                </div>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

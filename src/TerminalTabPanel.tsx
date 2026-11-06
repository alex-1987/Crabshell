import { t } from "./i18n";
import { paneTitle, statusLabel, titleOf, withShortcut } from "./labels";
import SplitView from "./SplitView";
import { terminalStore } from "./terminalStore";
import type { SplitDirection, TerminalTab } from "./terminalTypes";

function SplitIcon({ direction }: { direction: SplitDirection }) {
  return (
    <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 16 16" width="15">
      <rect height="12" rx="2" width="14" x="1" y="2" />
      {direction === "row" ? <path d="M8 2v12" /> : <path d="M1 8h14" />}
    </svg>
  );
}

type TerminalTabPanelProps = {
  tab: TerminalTab;
  active: boolean;
  /** Split button clicked; `anchor` positions the "what should the new pane run" menu. */
  onSplit: (direction: SplitDirection, anchor: DOMRect) => void;
};

/** One tab's content: heading with split buttons, the pane(s) and the status bar. */
export default function TerminalTabPanel({ tab, active, onSplit }: TerminalTabPanelProps) {
  const title = titleOf(tab);
  const split = tab.panes.length > 1;
  return (
    <section aria-label={t("terminal.panel", { name: title })} className={`terminal-tab-panel${active ? " terminal-tab-panel-active" : ""}`} role="tabpanel" style={{ display: active ? "flex" : "none" }}>
      <div className="terminal-frame">
        <div className="terminal-heading">
          <div className="terminal-target">
            <div className="target-icon" aria-hidden="true"><span /></div>
            <div><div className="target-name">{title}</div><div className="target-subtitle">{tab.kind === "local" ? t("terminal.localSubtitle") : t("terminal.sshSubtitle")}</div></div>
          </div>
          <div className="terminal-heading-actions">
            <div className="transport-tag"><span /> {tab.kind === "local" ? t("terminal.local") : "OPENSSH"} <b>·</b> PTY</div>
            <div aria-label={t("split.group")} className="split-buttons" role="group">
              {(["row", "column"] as const).map((direction) => {
                // Already split: the buttons switch the layout instead of adding a pane.
                const label = split
                  ? t(direction === "row" ? "menu.layoutRow" : "menu.layoutColumn")
                  : withShortcut(t(direction === "row" ? "menu.splitRow" : "menu.splitColumn"), terminalStore.shortcutLabel(direction === "row" ? "splitRight" : "splitDown"));
                return (
                  <button aria-label={label} aria-pressed={split && tab.split === direction} className="icon-button split-button" key={direction} onClick={(event) => onSplit(direction, event.currentTarget.getBoundingClientRect())} title={label} type="button">
                    <SplitIcon direction={direction} />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <SplitView paneTitle={paneTitle} statusLabel={statusLabel} tab={tab} />
        <div className="terminal-statusbar">
          <div className="status-message"><span className={`status-led status-${tab.status}`} />{tab.notice || statusLabel(tab.status)}</div>
          <div className="terminal-metrics">{tab.status === "connected" ? t("terminal.sessionActive") : t("terminal.localSession")}<span>UTF-8</span></div>
        </div>
      </div>
    </section>
  );
}

import { t } from "./i18n";
import { paneTitle, statusLabel, titleOf } from "./labels";
import SplitView from "./SplitView";
import type { SplitDirection, TerminalTab } from "./terminalTypes";

/** Split layout symbol for the tab bar: two panes side by side ("row") or stacked ("column"). */
export function SplitIcon({ direction }: { direction: SplitDirection }) {
  return (
    <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 16 16" width="14">
      <rect height="12" rx="1.5" width="14" x="1" y="2" />
      {direction === "row" ? <path d="M8 2v12" /> : <path d="M1 8h14" />}
    </svg>
  );
}

/** One tab's content: only the terminal pane(s); status and messages live in the tab and in overlays. */
export default function TerminalTabPanel({ tab, active }: { tab: TerminalTab; active: boolean }) {
  return (
    <section aria-label={t("terminal.panel", { name: titleOf(tab) })} className="terminal-tab-panel" hidden={!active} role="tabpanel">
      <SplitView paneTitle={paneTitle} statusLabel={statusLabel} tab={tab} />
    </section>
  );
}

import { t } from "./i18n";
import type { SavedHost, SessionStatus, TerminalPaneState, TerminalTab } from "./terminalTypes";

/** Display texts for tabs, panes and servers. */

export function statusLabel(status: SessionStatus): string {
  return t(`status.${status}`);
}

export function paneTitle(pane: TerminalPaneState): string {
  return pane.kind === "local" ? t("tabs.localShell") : pane.title;
}

/** Automatic tab label: the pane title, or both titles for a split tab. */
export function automaticTitleOf(tab: TerminalTab): string {
  return tab.panes.map(paneTitle).join(tab.split === "column" ? " / " : " | ");
}

/** Tab label: the name the user gave it, otherwise the automatic title. */
export function titleOf(tab: TerminalTab): string {
  return tab.customTitle || automaticTitleOf(tab);
}

/** Accent color of a tab: the user's choice, otherwise the design's tab color. */
export function tabColorOf(tab: TerminalTab): string {
  return tab.customColor || tab.appearance.tabColor;
}

/** "user@host" plus ":port" when it is not the default. */
export function serverAddress(server: SavedHost): string {
  return `${server.username ? `${server.username}@` : ""}${server.host}${server.port && server.port !== 22 ? `:${server.port}` : ""}`;
}

/** Last path segment (Unix and Windows separators). */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function withShortcut(label: string, shortcut: string): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

/** Panes whose shell or SSH connection is still alive. */
export function runningSessionCount(tabs: TerminalTab[]): number {
  return tabs.reduce((count, tab) => count + tab.panes.filter((pane) => pane.status === "connected" || pane.status === "connecting").length, 0);
}

import ColorField from "./ColorField";
import { t } from "./i18n";
import type { TerminalTab } from "./terminalTypes";
import { useFloatingMenu } from "./useFloatingMenu";

/** Quick colors for tabs: clearly distinguishable in the light and the dark theme. */
const TAB_COLORS = ["#c7e77a", "#4fb36b", "#3fb8af", "#4f8fe8", "#8a6bd8", "#d86bb0", "#e85d5d", "#f08c3a", "#f2c94c", "#a07a52"];

type TabMenuProps = {
  tab: TerminalTab;
  x: number;
  y: number;
  onRename: () => void;
  /** Disconnect a running session, or reconnect/restart an ended one. */
  onSession: () => void;
  onColor: (color: string) => void;
  onCloseTab: () => void;
  onClose: () => void;
};

/** Right-click menu of a tab: rename, disconnect/reconnect, tab color, close. */
export default function TabMenu({ tab, x, y, onRename, onSession, onColor, onCloseTab, onClose }: TabMenuProps) {
  // Arrow keys move between the menu entries, not into the color swatches.
  const { ref, position, handleMenuKey } = useFloatingMenu({ x, y, onClose, itemSelector: ".context-menu-item" });
  const designColor = tab.appearance.tabColor;
  const running = tab.status === "connected" || tab.status === "connecting";
  const local = tab.kind === "local";
  const sessionLabel = running ? (local ? t("topbar.stop") : t("topbar.disconnect")) : (local ? t("topbar.restart") : t("topbar.reconnect"));

  return (
    <div aria-label={t("tabMenu.label")} className="context-menu tab-menu" onContextMenu={(event) => event.preventDefault()} onKeyDown={(event) => { if (!(event.target instanceof HTMLInputElement)) handleMenuKey(event); }} ref={ref} role="menu" style={position}>
      <button className="context-menu-item" onClick={onRename} role="menuitem" type="button">{t("tabMenu.rename")}</button>
      <button className="context-menu-item" disabled={tab.status === "disconnecting"} onClick={onSession} role="menuitem" type="button">{sessionLabel}</button>

      <div className="split-menu-title split-menu-section context-menu-separated">{t("tabMenu.color")}</div>
      <div className="tab-menu-colors">
        <button
          aria-label={t("tabMenu.colorDefault")}
          aria-pressed={!tab.customColor}
          className="tab-menu-swatch tab-menu-swatch-default"
          onClick={() => onColor("")}
          style={{ background: designColor }}
          title={t("tabMenu.colorDefault")}
          type="button"
        />
        {TAB_COLORS.map((color) => (
          <button aria-label={color} aria-pressed={tab.customColor === color} className="tab-menu-swatch" key={color} onClick={() => onColor(color)} style={{ background: color }} title={color} type="button" />
        ))}
      </div>
      <div className="tab-menu-custom">
        <ColorField label={t("tabMenu.colorCustom")} onChange={onColor} value={tab.customColor || designColor} />
      </div>

      <button className="context-menu-item context-menu-separated" onClick={onCloseTab} role="menuitem" type="button">{t("tabMenu.close")}</button>
    </div>
  );
}

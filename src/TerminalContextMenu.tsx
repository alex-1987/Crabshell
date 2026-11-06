import { t } from "./i18n";
import { terminalStore } from "./terminalStore";
import type { TerminalContextMenu as MenuState } from "./terminalTypes";
import { useFloatingMenu } from "./useFloatingMenu";

type Action = "copy" | "paste" | "selectAll" | "snippets" | "splitRow" | "splitColumn" | "closePane";

/** Right-click menu for terminals; shown even when a program has taken over the mouse. */
export default function TerminalContextMenu({ menu }: { menu: MenuState }) {
  const { ref, position, handleMenuKey } = useFloatingMenu({ x: menu.x, y: menu.y, onClose: () => terminalStore.closeContextMenu() });

  const items: { action: Action; label: string; shortcut?: string; disabled?: boolean; separator?: boolean }[] = [
    { action: "copy", label: t("menu.copy"), shortcut: terminalStore.shortcutLabel("copy"), disabled: !menu.hasSelection },
    { action: "paste", label: t("menu.paste"), shortcut: terminalStore.shortcutLabel("paste"), disabled: !menu.canPaste },
    { action: "selectAll", label: t("menu.selectAll") },
    { action: "snippets", label: t("menu.snippets"), shortcut: terminalStore.shortcutLabel("snippets") },
    // A split tab offers switching the direction; the shortcuts always split with the same session.
    { action: "splitRow", label: menu.split ? t("menu.layoutRow") : t("menu.splitRow"), shortcut: menu.split ? undefined : terminalStore.shortcutLabel("splitRight"), separator: true },
    { action: "splitColumn", label: menu.split ? t("menu.layoutColumn") : t("menu.splitColumn"), shortcut: menu.split ? undefined : terminalStore.shortcutLabel("splitDown") },
    ...(menu.split ? [{ action: "closePane" as const, label: t("menu.closePane"), shortcut: terminalStore.shortcutLabel("close") }] : []),
  ];

  return (
    <div aria-label={t("menu.label")} className="context-menu" onContextMenu={(event) => event.preventDefault()} onKeyDown={handleMenuKey} ref={ref} role="menu" style={position}>
      {items.map((item) => (
        <button className={`context-menu-item${item.separator ? " context-menu-separated" : ""}`} disabled={item.disabled} key={item.action} onClick={() => terminalStore.runContextAction(item.action)} role="menuitem" type="button">
          <span>{item.label}</span>
          {item.shortcut && <kbd>{item.shortcut}</kbd>}
        </button>
      ))}
    </div>
  );
}

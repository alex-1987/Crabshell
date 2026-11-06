import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { t } from "./i18n";
import { terminalStore } from "./terminalStore";
import type { TerminalContextMenu as MenuState } from "./terminalTypes";

type Action = "copy" | "paste" | "selectAll" | "snippets";

/** Right-click menu for terminals; shown even when a program has taken over the mouse. */
export default function TerminalContextMenu({ menu }: { menu: MenuState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });

  const items: { action: Action; label: string; shortcut?: string; disabled?: boolean }[] = [
    { action: "copy", label: t("menu.copy"), shortcut: "Ctrl+Shift+C", disabled: !menu.hasSelection },
    { action: "paste", label: t("menu.paste"), shortcut: "Ctrl+Shift+V", disabled: !menu.canPaste },
    { action: "selectAll", label: t("menu.selectAll") },
    { action: "snippets", label: t("menu.snippets"), shortcut: "Ctrl+Shift+S" },
  ];

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - height - 4)),
    });
    element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu.x, menu.y]);

  useEffect(() => {
    const close = () => terminalStore.closeContextMenu();
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close, true);
    };
  }, []);

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      terminalStore.closeContextMenu();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    }
  }

  return (
    <div aria-label={t("menu.label")} className="context-menu" onContextMenu={(event) => event.preventDefault()} onKeyDown={handleKey} ref={ref} role="menu" style={position}>
      {items.map((item) => (
        <button className="context-menu-item" disabled={item.disabled} key={item.action} onClick={() => terminalStore.runContextAction(item.action)} role="menuitem" type="button">
          <span>{item.label}</span>
          {item.shortcut && <kbd>{item.shortcut}</kbd>}
        </button>
      ))}
    </div>
  );
}

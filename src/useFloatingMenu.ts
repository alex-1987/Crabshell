import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

type FloatingMenuOptions = {
  /** Where the menu was opened (client coordinates). */
  x: number;
  y: number;
  onClose: () => void;
  /** Element focused when the menu opens. */
  focusSelector?: string;
  /** Items the arrow keys move between. */
  itemSelector?: string;
};

/**
 * Shared behavior of Crabshell's pop-up menus (terminal, split, tab): kept inside the window,
 * first item focused, closed by Escape, a click or scrolling outside, resizing or leaving the
 * window, arrow keys move between the items.
 */
export function useFloatingMenu({ x, y, onClose, focusSelector = "button:not(:disabled)", itemSelector = "button:not(:disabled)" }: FloatingMenuOptions) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
    element.querySelector<HTMLElement>(focusSelector)?.focus();
    // Positioned once per opening; the content may change size afterwards (search).
  }, [x, y, focusSelector]);

  useEffect(() => {
    const close = () => onCloseRef.current();
    // Clicks and scrolling inside the menu (e.g. its server list) keep it open.
    const outside = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("wheel", outside, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("wheel", outside, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, []);

  /** Escape closes, arrow keys move the focus. Returns true when the key was handled. */
  function handleMenuKey(event: KeyboardEvent<HTMLElement>): boolean {
    if (event.key === "Escape") {
      event.preventDefault();
      onCloseRef.current();
      return true;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
    event.preventDefault();
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(itemSelector) ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
    return true;
  }

  return { ref, position, handleMenuKey };
}

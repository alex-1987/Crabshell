import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Tabs cut off on each side of the tab strip (also partly hidden ones). */
export type TabOverflow = { left: number; right: number };

const NONE: TabOverflow = { left: 0, right: 0 };
/** Rounding of fractional zoom levels; less than this does not count as hidden. */
const TOLERANCE = 2;

function tabsOf(strip: HTMLElement): HTMLElement[] {
  return Array.from(strip.querySelectorAll<HTMLElement>(":scope > .terminal-tab"));
}

function smooth(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/**
 * Overflow of the tab strip: how many tabs are hidden left and right, scrolling to the next
 * hidden tab (arrow buttons), the mouse wheel scrolling sideways, and the active tab kept in view.
 * `layoutKey` changes whenever tabs are added, removed, renamed or reordered.
 */
export function useTabOverflow(activeTabId: string | null, layoutKey: string) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState<TabOverflow>(NONE);

  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (!strip || strip.scrollWidth <= strip.clientWidth + TOLERANCE) {
      setOverflow((current) => (current.left || current.right ? NONE : current));
      return;
    }
    const box = strip.getBoundingClientRect();
    let left = 0;
    let right = 0;
    for (const tab of tabsOf(strip)) {
      const rect = tab.getBoundingClientRect();
      if (rect.left < box.left - TOLERANCE) left += 1;
      else if (rect.right > box.right + TOLERANCE) right += 1;
    }
    setOverflow((current) => (current.left === left && current.right === right ? current : { left, right }));
  }, []);

  // Window and panel resizes change the strip; tab changes change its content.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    strip.addEventListener("scroll", measure, { passive: true });
    // A vertical wheel scrolls the strip sideways (there is no visible scrollbar).
    const wheel = (event: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      strip.scrollLeft += event.deltaY;
    };
    strip.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      strip.removeEventListener("scroll", measure);
      strip.removeEventListener("wheel", wheel);
    };
  }, [measure]);

  useLayoutEffect(measure, [measure, layoutKey]);

  // Keep the active tab visible (new tab, Ctrl+Tab, click on a half hidden tab).
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const tab = strip && tabsOf(strip).find((item) => item.dataset.tabId === activeTabId);
    if (!strip || !tab) return;
    const box = strip.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    if (rect.left < box.left) strip.scrollBy({ left: rect.left - box.left, behavior: smooth() });
    else if (rect.right > box.right) strip.scrollBy({ left: rect.right - box.right, behavior: smooth() });
  }, [activeTabId, layoutKey]);

  /** Brings the next hidden tab on that side fully into view. */
  const scrollToHidden = useCallback((side: "left" | "right") => {
    const strip = stripRef.current;
    if (!strip) return;
    const box = strip.getBoundingClientRect();
    const tabs = tabsOf(strip).map((tab) => tab.getBoundingClientRect());
    const target = side === "left"
      ? tabs.filter((rect) => rect.left < box.left - TOLERANCE).at(-1)
      : tabs.find((rect) => rect.right > box.right + TOLERANCE);
    if (!target) return;
    strip.scrollBy({ left: side === "left" ? target.left - box.left : target.right - box.right, behavior: smooth() });
  }, []);

  return { stripRef, overflow, scrollToHidden };
}

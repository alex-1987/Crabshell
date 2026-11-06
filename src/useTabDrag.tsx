import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { t } from "./i18n";
import { terminalStore } from "./terminalStore";
import type { SplitDirection, TerminalTab } from "./terminalTypes";

/** Pixels the pointer has to move before a press on a tab becomes a drag. */
const DRAG_THRESHOLD = 6;
/** Hovering over another tab this long while dragging shows that tab, so its terminal becomes a drop target. */
const HOVER_ACTIVATE_MS = 550;

type Rect = { left: number; top: number; width: number; height: number };

type DropTarget =
  | { kind: "reorder"; index: number; markerX: number; markerTop: number; markerHeight: number }
  | { kind: "split"; tabId: string; direction: SplitDirection; first: boolean; rect: Rect }
  | { kind: "blocked"; rect: Rect }
  | { kind: "none" };

type Drag = { tabId: string; pointerId: number; startX: number; startY: number; x: number; y: number; active: boolean; target: DropTarget };

/**
 * Drag tabs with the mouse: drop on the tab strip to reorder, or on the visible terminal to
 * show both tabs side by side (left/right/top/bottom half, chosen by the nearest edge).
 * Uses pointer events instead of HTML5 drag and drop, which Tauri reserves for file drops.
 */
export function useTabDrag(tabs: TerminalTab[], activeTabId: string | null, titleOf: (tab: TerminalTab) => string) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  /** Set when a drag ended, so the click that follows pointerup does not also activate the tab. */
  const suppressClickRef = useRef(false);
  const hoverRef = useRef<{ tabId: string; timer: number } | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabRef = useRef(activeTabId);
  activeTabRef.current = activeTabId;

  function update(next: Drag | null) {
    dragRef.current = next;
    setDrag(next);
  }

  function clearHover() {
    if (hoverRef.current) window.clearTimeout(hoverRef.current.timer);
    hoverRef.current = null;
  }

  function hitTest(sourceId: string, x: number, y: number): DropTarget {
    const element = document.elementFromPoint(x, y);
    const strip = element?.closest(".terminal-tabs");
    if (strip) {
      const tabElements = Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-id]"));
      const others = tabElements.filter((item) => item.dataset.tabId !== sourceId);
      let index = others.length;
      for (let position = 0; position < others.length; position += 1) {
        const rect = others[position].getBoundingClientRect();
        if (x < rect.left + rect.width / 2) {
          index = position;
          break;
        }
      }
      const reference = others[index]?.getBoundingClientRect() ?? others.at(-1)?.getBoundingClientRect();
      const stripRect = strip.getBoundingClientRect();
      const markerX = reference ? (others[index] ? reference.left : reference.right) : stripRect.left + 4;
      // Hovering over another tab for a moment brings its terminal to the front.
      const hovered = element?.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId;
      if (hovered && hovered !== sourceId && hovered !== activeTabRef.current) {
        if (hoverRef.current?.tabId !== hovered) {
          clearHover();
          hoverRef.current = { tabId: hovered, timer: window.setTimeout(() => terminalStore.activateTab(hovered), HOVER_ACTIVATE_MS) };
        }
      } else {
        clearHover();
      }
      return { kind: "reorder", index, markerX, markerTop: reference?.top ?? stripRect.top, markerHeight: reference?.height ?? stripRect.height };
    }
    clearHover();

    const area = element?.closest<HTMLElement>("[data-split-tab]");
    const targetId = area?.dataset.splitTab;
    if (!area || !targetId || targetId === sourceId) return { kind: "none" };
    const box = area.getBoundingClientRect();
    if (!terminalStore.canMergeTabs(sourceId, targetId)) {
      return { kind: "blocked", rect: { left: box.left, top: box.top, width: box.width, height: box.height } };
    }
    const relX = (x - box.left) / box.width;
    const relY = (y - box.top) / box.height;
    const edges = [
      { direction: "row" as const, first: true, distance: relX },
      { direction: "row" as const, first: false, distance: 1 - relX },
      { direction: "column" as const, first: true, distance: relY },
      { direction: "column" as const, first: false, distance: 1 - relY },
    ];
    const nearest = edges.reduce((best, edge) => (edge.distance < best.distance ? edge : best));
    const half = nearest.direction === "row"
      ? { left: nearest.first ? box.left : box.left + box.width / 2, top: box.top, width: box.width / 2, height: box.height }
      : { left: box.left, top: nearest.first ? box.top : box.top + box.height / 2, width: box.width, height: box.height / 2 };
    return { kind: "split", tabId: targetId, direction: nearest.direction, first: nearest.first, rect: half };
  }

  function finish(commit: boolean) {
    const current = dragRef.current;
    clearHover();
    update(null);
    if (!current?.active) return;
    suppressClickRef.current = true;
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    if (!commit) return;
    const target = current.target;
    if (target.kind === "reorder") terminalStore.moveTab(current.tabId, target.index);
    else if (target.kind === "split") terminalStore.mergeTabs(current.tabId, target.tabId, target.direction, target.first);
  }

  // Escape cancels a running drag.
  useEffect(() => {
    if (!drag?.active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  useEffect(() => clearHover, []);

  /** Spread onto each tab's select button. */
  function tabHandlers(tabId: string) {
    return {
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        update({ tabId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, target: { kind: "none" } });
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const current = dragRef.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const moved = Math.hypot(event.clientX - current.startX, event.clientY - current.startY) >= DRAG_THRESHOLD;
        if (!current.active && !moved) return;
        update({ ...current, x: event.clientX, y: event.clientY, active: true, target: hitTest(current.tabId, event.clientX, event.clientY) });
      },
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
        if (dragRef.current?.pointerId === event.pointerId) finish(true);
      },
      onPointerCancel: () => finish(false),
      onLostPointerCapture: () => { if (dragRef.current?.active) finish(false); else update(null); },
      onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
        if (suppressClickRef.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
    };
  }

  const dragging = drag?.active ? drag : null;
  const source = dragging ? tabs.find((tab) => tab.id === dragging.tabId) : undefined;
  const overlay = dragging && source ? (
    <div aria-hidden="true" className="tab-drag-layer">
      {dragging.target.kind === "reorder" && (
        <div className="tab-drop-marker" style={{ left: dragging.target.markerX - 1, top: dragging.target.markerTop, height: dragging.target.markerHeight }} />
      )}
      {dragging.target.kind === "split" && (
        <div className="tab-drop-zone" style={dragging.target.rect}>
          <span>{dragging.target.direction === "row" ? (dragging.target.first ? t("drag.left") : t("drag.right")) : (dragging.target.first ? t("drag.top") : t("drag.bottom"))}</span>
        </div>
      )}
      {dragging.target.kind === "blocked" && (
        <div className="tab-drop-zone tab-drop-blocked" style={dragging.target.rect}><span>{t("drag.full")}</span></div>
      )}
      <div className="tab-drag-ghost" style={{ left: dragging.x + 12, top: dragging.y + 10 }}>{titleOf(source)}</div>
    </div>
  ) : null;

  return { tabHandlers, overlay, draggingTabId: dragging?.tabId ?? null };
}

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { t } from "./i18n";
import type { RemoteItem } from "./sftp";
import { terminalStore } from "./terminalStore";

/** Pixels the pointer has to move before a press on a file becomes a drag. */
const DRAG_THRESHOLD = 5;
/** Holding a dragged file over a tab this long shows that tab (and its server's files). */
const HOVER_ACTIVATE_MS = 600;

/** The file or folder being dragged, with the server it comes from. */
export type DragSource = RemoteItem;

type Drag = { source: DragSource; pointerId: number; startX: number; startY: number; x: number; y: number; active: boolean; targetDir: string | null };

/**
 * Drag files and folders inside the file browser: drop targets carry `data-drop-dir`, holding
 * over a tab switches to it, so a file can go to another server. Pointer events, not HTML5
 * drag and drop (Tauri keeps that for files from the desktop). Listens on the document, as the
 * dragged row disappears when the browser switches to another server.
 */
export function useFileDrag({ canDrop, onDrop }: {
  /** Whether the folder takes the dragged item (checked against the server shown now). */
  canDrop: (source: DragSource, dir: string) => boolean;
  onDrop: (source: DragSource, dir: string, x: number, y: number) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const callbacks = useRef({ canDrop, onDrop });
  callbacks.current = { canDrop, onDrop };
  const hoverRef = useRef<{ tabId: string; timer: number } | null>(null);
  /** The click after a drag must not also select or open the row. */
  const suppressClickRef = useRef(false);

  function update(next: Drag | null) {
    dragRef.current = next;
    setDrag(next);
  }

  function clearHover() {
    if (hoverRef.current) window.clearTimeout(hoverRef.current.timer);
    hoverRef.current = null;
  }

  function hitTest(current: Drag, x: number, y: number): string | null {
    const element = document.elementFromPoint(x, y);
    const tab = element?.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId;
    if (tab) {
      if (hoverRef.current?.tabId !== tab) {
        clearHover();
        hoverRef.current = { tabId: tab, timer: window.setTimeout(() => terminalStore.activateTab(tab), HOVER_ACTIVATE_MS) };
      }
      return null;
    }
    clearHover();
    const dir = element?.closest<HTMLElement>("[data-drop-dir]")?.dataset.dropDir;
    return dir && callbacks.current.canDrop(current.source, dir) ? dir : null;
  }

  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const active = current.active || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) >= DRAG_THRESHOLD;
      if (!active) return;
      event.preventDefault();
      update({ ...current, active, x: event.clientX, y: event.clientY, targetDir: hitTest(current, event.clientX, event.clientY) });
    };
    const end = (event: PointerEvent, commit: boolean) => {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      clearHover();
      update(null);
      if (!current.active) return;
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      if (commit && current.targetDir) callbacks.current.onDrop(current.source, current.targetDir, event.clientX, event.clientY);
    };
    const up = (event: PointerEvent) => end(event, true);
    const cancel = (event: PointerEvent) => end(event, false);
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dragRef.current) return;
      event.preventDefault();
      clearHover();
      update(null);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", key, true);
    document.body.classList.toggle("list-dragging", drag.active);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", key, true);
      document.body.classList.remove("list-dragging");
    };
  }, [drag !== null, drag?.active]);

  useEffect(() => clearHover, []);

  /** Spread onto a file row. */
  function sourceProps(source: () => DragSource | null) {
    return {
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0 || dragRef.current) return;
        // Not from the rename field.
        if ((event.target as HTMLElement).closest("input")) return;
        const item = source();
        if (!item) return;
        update({ source: item, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, targetDir: null });
      },
      onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
        if (!suppressClickRef.current) return;
        event.preventDefault();
        event.stopPropagation();
      },
    };
  }

  const dragging = drag?.active ? drag : null;
  const overlay = dragging ? (
    <div aria-hidden="true" className="tab-drag-layer">
      <div className="tab-drag-ghost" style={{ left: dragging.x + 12, top: dragging.y + 10 }}>
        {dragging.source.isDir ? "📁" : "📄"} {dragging.source.name}
        <div className="file-drag-hint">{dragging.targetDir ?? t("files.dragTabHint")}</div>
      </div>
    </div>
  ) : null;

  return { sourceProps, overlay, draggingPath: dragging?.source.path ?? null, targetDir: dragging?.targetDir ?? null };
}

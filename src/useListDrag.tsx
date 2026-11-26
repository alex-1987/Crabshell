import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** Pixels the pointer has to move before a press becomes a drag (smaller moves stay clicks). */
const DRAG_THRESHOLD = 6;

type Target = { key: string; after: boolean; rect: DOMRect };
type Drag = { key: string; x: number; y: number; target: Target | null };

type ListDragOptions = {
  /**
   * Names the list: items carry `data-drag-<scope>="<key>"`. An element can belong to several
   * lists (e.g. a group heading that is dragged itself and also takes dropped servers).
   */
  scope: string;
  /** "y" for lists, "x" for rows of chips: decides whether the drop goes before or after the target. */
  axis: "x" | "y";
  /** Text of the ghost that follows the pointer. */
  label: (key: string) => string;
  /** Whether `source` may be dropped on `target`; default: any other item. */
  canDrop?: (source: string, target: string) => boolean;
  onDrop: (source: string, target: string, after: boolean) => void;
  disabled?: boolean;
};

/**
 * Reorder items with the mouse. Uses pointer events and window listeners instead of HTML5 drag
 * and drop (which Tauri reserves for file drops) and without pointer capture, so the buttons in
 * a row keep their normal clicks. Escape cancels a drag.
 */
export function useListDrag({ scope, axis, label, canDrop, onDrop, disabled = false }: ListDragOptions) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const options = useRef({ label, canDrop, onDrop });
  options.current = { label, canDrop, onDrop };
  const cleanup = useRef<(() => void) | null>(null);
  const attribute = `data-drag-${scope}`;

  useEffect(() => () => cleanup.current?.(), []);

  function hitTest(source: string, x: number, y: number): Target | null {
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>(`[${attribute}]`);
    const key = element?.getAttribute(attribute);
    if (!element || key === null || key === undefined || key === source) return null;
    if (options.current.canDrop && !options.current.canDrop(source, key)) return null;
    const rect = element.getBoundingClientRect();
    const after = axis === "y" ? y > rect.top + rect.height / 2 : x > rect.left + rect.width / 2;
    return { key, after, rect };
  }

  function start(event: ReactPointerEvent<HTMLElement>, key: string) {
    if (disabled || event.button !== 0 || cleanup.current) return;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let current: Drag | null = null;

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!current && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD) return;
      if (!current) document.body.classList.add("list-dragging");
      current = { key, x: moveEvent.clientX, y: moveEvent.clientY, target: hitTest(key, moveEvent.clientX, moveEvent.clientY) };
      setDrag(current);
    };
    const finish = (commit: boolean) => {
      cleanup.current?.();
      setDrag(null);
      if (!current) return;
      // The click that follows pointerup must not also open or toggle the item.
      const swallow = (clickEvent: MouseEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
      };
      window.addEventListener("click", swallow, true);
      window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      if (commit && current.target) options.current.onDrop(current.key, current.target.key, current.target.after);
    };
    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId === pointerId) finish(true);
    };
    const cancel = () => finish(false);
    const keydown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape" && current) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        finish(false);
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", keydown, true);
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", keydown, true);
      document.body.classList.remove("list-dragging");
      cleanup.current = null;
    };
  }

  /** Spread onto a draggable item (it is also a drop target). */
  function itemProps(key: string) {
    return {
      [attribute]: key,
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => start(event, key),
    };
  }

  /** Spread onto an element that only takes drops (e.g. a group heading for servers). */
  function targetProps(key: string) {
    return { [attribute]: key };
  }

  const target = drag?.target;
  const marker = target
    ? axis === "y"
      ? { left: target.rect.left, top: (target.after ? target.rect.bottom : target.rect.top) - 1, width: target.rect.width, height: 2 }
      : { left: (target.after ? target.rect.right : target.rect.left) - 1, top: target.rect.top, width: 2, height: target.rect.height }
    : null;
  const overlay = drag ? (
    <div aria-hidden="true" className="tab-drag-layer">
      {marker && <div className="tab-drop-marker" style={marker} />}
      <div className="tab-drag-ghost" style={{ left: drag.x + 12, top: drag.y + 10 }}>{options.current.label(drag.key)}</div>
    </div>
  ) : null;

  return { itemProps, targetProps, overlay, draggingKey: drag?.key ?? null };
}

/** `keys` with `source` moved before or after `target`; unchanged when either is missing. */
export function reorderKeys(keys: string[], source: string, target: string, after: boolean): string[] {
  if (!keys.includes(source) || !keys.includes(target) || source === target) return keys;
  const rest = keys.filter((key) => key !== source);
  const index = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, index), source, ...rest.slice(index)];
}

/** Sorts by position in `order`; keys missing there follow in the order of `fallback`. */
export function byOrder<T>(items: T[], keyOf: (item: T) => string, order: readonly string[], fallback: (a: T, b: T) => number): T[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...items].sort((a, b) => {
    const rankA = rank.get(keyOf(a));
    const rankB = rank.get(keyOf(b));
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return fallback(a, b);
  });
}

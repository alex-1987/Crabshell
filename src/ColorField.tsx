import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { t } from "./i18n";

type Hsv = { h: number; s: number; v: number };

const PRESETS = [
  "#0f120e", "#1d2119", "#2b2f36", "#f0f2eb", "#c8d0c0", "#ffffff",
  "#9ebc65", "#c7e77a", "#4fb36b", "#3fb8af", "#4f8fe8", "#8a6bd8",
  "#d86bb0", "#e85d5d", "#f08c3a", "#f2c94c", "#a07a52", "#7d8778",
];

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

function normalizeHex(input: string): string | null {
  let value = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(value)) value = value.split("").map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/.test(value) ? `#${value}` : null;
}

function hexToHsv(hex: string): Hsv {
  const value = normalizeHex(hex) ?? "#000000";
  const r = parseInt(value.slice(1, 3), 16) / 255;
  const g = parseInt(value.slice(3, 5), 16) / 255;
  const b = parseInt(value.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? delta / max : 0, v: max };
}

function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    const channel = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(channel * 255).toString(16).padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}

/** Drag helper: calls `onMove` with the pointer position relative to the element (0..1). */
function useDrag(onMove: (x: number, y: number) => void) {
  return (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const move = (clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect();
      onMove(clamp((clientX - rect.left) / rect.width), clamp((clientY - rect.top) / rect.height));
    };
    element.setPointerCapture(event.pointerId);
    move(event.clientX, event.clientY);
    const onPointerMove = (e: PointerEvent) => move(e.clientX, e.clientY);
    const stop = () => {
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", stop);
      element.removeEventListener("pointercancel", stop);
    };
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", stop);
    element.addEventListener("pointercancel", stop);
  };
}

const POPOVER_WIDTH = 222;
const POPOVER_HEIGHT = 300;

/** Open the picker towards the side of the dialog that has room for it. */
function placementFor(field: HTMLElement | null) {
  const container = field?.closest(".server-dialog") ?? document.body;
  if (!field) return { right: false, up: false };
  const fieldRect = field.getBoundingClientRect();
  const boxRect = container.getBoundingClientRect();
  // Rects are in screen pixels, the popover sizes in CSS pixels of the zoomed dialog.
  const zoom = field.offsetWidth ? fieldRect.width / field.offsetWidth : 1;
  const right = fieldRect.left + POPOVER_WIDTH * zoom > boxRect.right - 8;
  const roomBelow = Math.min(boxRect.bottom, window.innerHeight) - fieldRect.top - 40 * zoom;
  const roomAbove = fieldRect.top - Math.max(boxRect.top, 0);
  const up = roomBelow < POPOVER_HEIGHT * zoom && roomAbove > roomBelow;
  return { right, up };
}

type ColorFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
};

/** Colour swatch with an in-app picker (the GTK colour dialog of WebKitGTK does not show colours reliably). */
export default function ColorField({ label, value, onChange }: ColorFieldProps) {
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [hexText, setHexText] = useState(value);
  const [placement, setPlacement] = useState({ right: false, up: false });
  const rootRef = useRef<HTMLDivElement>(null);

  // Follow outside changes (other design selected) without losing the hue of greys.
  useEffect(() => {
    setHexText(value);
    setHsv((current) => (hsvToHex(current) === normalizeHex(value) ? current : hexToHsv(value)));
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const apply = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setHexText(hex);
    onChange(hex);
  };
  const dragArea = useDrag((x, y) => apply({ h: hsv.h, s: x, v: 1 - y }));
  const dragHue = useDrag((x) => apply({ ...hsv, h: Math.min(359.9, x * 360) }));

  const commitHex = (text: string) => {
    const hex = normalizeHex(text);
    if (hex) {
      setHsv(hexToHsv(hex));
      onChange(hex);
    }
  };

  return (
    <div
      className="color-field"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
      ref={rootRef}
    >
      <button
        aria-expanded={open}
        aria-label={label}
        className="color-swatch"
        onClick={() => {
          if (!open) setPlacement(placementFor(rootRef.current));
          setOpen(!open);
        }}
        style={{ background: value }}
        type="button"
      />
      <span>{label}</span>
      <code>{value}</code>

      {open && (
        <div className={`color-popover${placement.right ? " color-popover-right" : ""}${placement.up ? " color-popover-up" : ""}`} role="dialog" aria-label={label}>
          <div
            className="color-area"
            onPointerDown={dragArea}
            style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))` }}
          >
            <span className="color-area-handle" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: value }} />
          </div>
          <div className="color-hue" onPointerDown={dragHue}>
            <span className="color-hue-handle" style={{ left: `${(hsv.h / 360) * 100}%` }} />
          </div>
          <div className="color-hex-row">
            <span className="color-preview" style={{ background: value }} />
            <input
              aria-label={t("settings.hexColor")}
              maxLength={7}
              onBlur={() => setHexText(value)}
              onChange={(event) => {
                setHexText(event.target.value);
                commitHex(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitHex(hexText);
                  setOpen(false);
                }
              }}
              spellCheck={false}
              value={hexText}
            />
          </div>
          <div className="color-presets">
            {PRESETS.map((preset) => (
              <button
                aria-label={preset}
                aria-pressed={preset === value}
                className="color-preset"
                key={preset}
                onClick={() => commitHex(preset)}
                style={{ background: preset }}
                title={preset}
                type="button"
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

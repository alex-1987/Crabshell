import type { MessageKey } from "./i18n";

/** Terminal shortcuts that can be rebound in Settings → Shortcuts. */
export type KeyAction =
  | "copy"
  | "paste"
  | "snippets"
  | "localShell"
  | "close"
  | "nextTab"
  | "previousTab"
  | "splitRight"
  | "splitDown"
  | "otherPane"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "toggleSidebar";

/** Stored per action; actions that are missing use the defaults. An empty list disables the action. */
export type Keybindings = Partial<Record<KeyAction, string[]>>;

export const KEY_ACTIONS: { action: KeyAction; label: MessageKey }[] = [
  { action: "copy", label: "keys.copy" },
  { action: "paste", label: "keys.paste" },
  { action: "snippets", label: "keys.snippets" },
  { action: "localShell", label: "keys.localShell" },
  { action: "close", label: "keys.close" },
  { action: "nextTab", label: "keys.nextTab" },
  { action: "previousTab", label: "keys.previousTab" },
  { action: "splitRight", label: "keys.splitRight" },
  { action: "splitDown", label: "keys.splitDown" },
  { action: "otherPane", label: "keys.otherPane" },
  { action: "zoomIn", label: "keys.zoomIn" },
  { action: "zoomOut", label: "keys.zoomOut" },
  { action: "zoomReset", label: "keys.zoomReset" },
  { action: "toggleSidebar", label: "keys.toggleSidebar" },
];

export const DEFAULT_KEYBINDINGS: Record<KeyAction, string[]> = {
  copy: ["Ctrl+Shift+C"],
  paste: ["Ctrl+Shift+V"],
  snippets: ["Ctrl+Shift+S"],
  localShell: ["Ctrl+Shift+T"],
  close: ["Ctrl+Shift+W"],
  nextTab: ["Ctrl+Tab"],
  previousTab: ["Ctrl+Shift+Tab"],
  splitRight: ["Ctrl+Shift+E"],
  splitDown: ["Ctrl+Shift+O"],
  otherPane: ["Ctrl+Alt+ArrowLeft", "Ctrl+Alt+ArrowRight", "Ctrl+Alt+ArrowUp", "Ctrl+Alt+ArrowDown"],
  // "+" is its own key on German layouts, Shift+= on US layouts; "=" alone works there too.
  zoomIn: ["Ctrl+Plus", "Ctrl+Shift+Plus", "Ctrl+="],
  zoomOut: ["Ctrl+-"],
  zoomReset: ["Ctrl+0"],
  // Not Ctrl+B: that is the tmux prefix and "back one character" in shells.
  toggleSidebar: ["Ctrl+Shift+B"],
};

/** Same limits as the backend (storage.rs). */
export const MAX_BINDINGS_PER_ACTION = 4;

export function resolveKeybindings(custom: Keybindings | undefined): Record<KeyAction, string[]> {
  const resolved = { ...DEFAULT_KEYBINDINGS };
  for (const { action } of KEY_ACTIONS) {
    const list = custom?.[action];
    if (Array.isArray(list)) resolved[action] = list.filter((combo) => typeof combo === "string" && combo.length > 0);
  }
  return resolved;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS", "Super", "Hyper", "CapsLock", "NumLock"]);

/**
 * Normalized combo for a key event, e.g. "Ctrl+Shift+E" or "Ctrl+Alt+ArrowLeft".
 * Modifiers are always in the order Ctrl, Alt, Shift, Super. Returns null for modifier-only presses.
 */
export function comboFromEvent(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key) || event.key === "Dead" || event.key === "Unidentified") return null;
  let key = event.key;
  if (key === " ") key = "Space";
  // "+" would clash with the separator in "Ctrl+Shift+E".
  else if (key === "+") key = "Plus";
  else if (key.length === 1) key = key.toUpperCase();
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  parts.push(key);
  return parts.join("+");
}

const KEY_SYMBOLS: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Escape: "Esc", Plus: "+" };

/** "Ctrl+Alt+ArrowLeft" → "Ctrl+Alt+←". */
export function displayCombo(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  return [...parts, KEY_SYMBOLS[key] ?? key].join("+");
}

/** Problems with a new combo: none, unusable (no modifier), or a warning (terminal control key). */
export function checkCombo(combo: string): "ok" | "needsModifier" | "terminalControl" {
  const parts = combo.split("+");
  const key = parts.at(-1) ?? "";
  const modifiers = parts.slice(0, -1);
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
  if (!isFunctionKey && !modifiers.some((modifier) => modifier === "Ctrl" || modifier === "Alt" || modifier === "Super")) {
    return "needsModifier";
  }
  // Ctrl+letter alone is a control character the program needs (Ctrl+C, Ctrl+D, Ctrl+R, ...).
  if (modifiers.length === 1 && modifiers[0] === "Ctrl" && /^[A-Z0-9[\]\\]$/.test(key)) return "terminalControl";
  return "ok";
}

/** Which action (if any) already uses a combo. */
export function actionForCombo(bindings: Record<KeyAction, string[]>, combo: string, except?: KeyAction): KeyAction | null {
  for (const { action } of KEY_ACTIONS) {
    if (action !== except && bindings[action].includes(combo)) return action;
  }
  return null;
}

/** First binding of an action for labels and tooltips, or "" when it is disabled. */
export function primaryCombo(bindings: Record<KeyAction, string[]>, action: KeyAction): string {
  const combo = bindings[action][0];
  return combo ? displayCombo(combo) : "";
}

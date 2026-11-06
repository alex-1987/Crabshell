import type { ITheme } from "@xterm/xterm";
import type { AppSettings, Appearance } from "./terminalTypes";

export const DEFAULT_APPEARANCE_ID = "default";
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;

export const builtinAppearance: Appearance = {
  id: DEFAULT_APPEARANCE_ID,
  name: "Crabshell",
  fontSize: 13,
  foreground: "#d8ded2",
  background: "#10120f",
  cursor: "#c7e77a",
  selection: "#65734b",
  tabColor: "#c7e77a",
};

export const defaultSettings: AppSettings = {
  sidebarWidth: 280,
  sidebarCollapsed: false,
  snippetPanelOpen: false,
  snippetPanelWidth: 280,
  serverOpenClick: "single",
  snippetInsertClick: "single",
  restoreTabs: false,
  copyOnSelect: false,
  confirmMultilinePaste: true,
  forceMouseSelection: false,
  allowClipboardWrite: true,
  clipboardRead: "ask",
  appearances: [builtinAppearance],
  defaultAppearanceId: DEFAULT_APPEARANCE_ID,
  localAppearanceId: "",
  themeMode: "dark",
  language: "system",
  uiScale: 100,
};

/** ANSI palette shared by all appearances; appearances override the base colors. */
const ansiPalette: ITheme = {
  black: "#20241e",
  red: "#ed7a62",
  green: "#b3d875",
  yellow: "#e4c47a",
  blue: "#8eabb7",
  magenta: "#b7a0bd",
  cyan: "#87c6b0",
  white: "#d8ded2",
  brightBlack: "#747d6d",
  brightRed: "#f18e78",
  brightGreen: "#c7e77a",
  brightYellow: "#efd28d",
  brightBlue: "#a4c4d2",
  brightMagenta: "#c7b1cd",
  brightCyan: "#9ad6c2",
  brightWhite: "#f1f3eb",
};

export function terminalTheme(appearance: Appearance): ITheme {
  return {
    ...ansiPalette,
    foreground: appearance.foreground,
    background: appearance.background,
    cursor: appearance.cursor,
    cursorAccent: appearance.background,
    // Semi-transparent so the text under the selection stays readable.
    selectionBackground: `${appearance.selection}88`,
  };
}

/** `preferredId` is the server's (or local shell's) design; empty falls back to the default. */
export function resolveAppearance(
  preferredId: string,
  appearances: Appearance[],
  defaultAppearanceId: string,
): Appearance {
  return (
    (preferredId && appearances.find((item) => item.id === preferredId)) ||
    appearances.find((item) => item.id === defaultAppearanceId) ||
    appearances[0] ||
    builtinAppearance
  );
}

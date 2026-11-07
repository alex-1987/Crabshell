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

/**
 * Extra designs of a new installation (two dark, two light). Only in the first settings
 * file; existing installations keep their designs, and all of these can be edited or deleted.
 */
const starterAppearances: Appearance[] = [
  { id: "midnight", name: "Midnight", fontSize: 13, foreground: "#d4dbe6", background: "#0f1520", cursor: "#7fb4ff", selection: "#2f4a73", tabColor: "#7fb4ff" },
  { id: "ember", name: "Ember", fontSize: 13, foreground: "#e8dccf", background: "#1a1412", cursor: "#f0a35e", selection: "#6b4a33", tabColor: "#f0a35e" },
  { id: "paper", name: "Paper", fontSize: 13, foreground: "#2b2a26", background: "#faf8f3", cursor: "#5d8a1c", selection: "#b9d38a", tabColor: "#5d8a1c" },
  { id: "daylight", name: "Daylight", fontSize: 13, foreground: "#1f2a37", background: "#f2f6fb", cursor: "#2f6fd0", selection: "#a9c6ef", tabColor: "#2f6fd0" },
];

export const defaultSettings: AppSettings = {
  sidebarWidth: 220,
  sidebarCollapsed: false,
  snippetPanelOpen: false,
  snippetPanelWidth: 220,
  serverOpenClick: "single",
  snippetInsertClick: "single",
  restoreTabs: false,
  confirmClose: true,
  checkUpdates: false,
  updatesAsked: false,
  keybindings: {},
  copyOnSelect: true,
  confirmMultilinePaste: true,
  forceMouseSelection: false,
  allowClipboardWrite: true,
  clipboardRead: "ask",
  appearances: [builtinAppearance, ...starterAppearances],
  defaultAppearanceId: DEFAULT_APPEARANCE_ID,
  localAppearanceId: "",
  themeMode: "dark",
  language: "system",
  uiScale: 100,
  uiFont: "",
  terminalFont: "",
};

/** ANSI palette of dark designs; designs override the base colors. */
const darkAnsiPalette: ITheme = {
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

/**
 * ANSI palette of light designs: darker colors, so a green prompt or `ls` output stays
 * readable on a light background. White is a grey for the same reason.
 */
const lightAnsiPalette: ITheme = {
  black: "#2b2f2a",
  red: "#b4402a",
  green: "#4d7a12",
  yellow: "#8a6a00",
  blue: "#2f6189",
  magenta: "#85508f",
  cyan: "#1f7a6b",
  white: "#7d8478",
  brightBlack: "#5a6156",
  brightRed: "#c9533b",
  brightGreen: "#5d8a1c",
  brightYellow: "#9c7a0a",
  brightBlue: "#3a74a3",
  brightMagenta: "#9a62a4",
  brightCyan: "#2a8f7e",
  brightWhite: "#555b50",
};

/** Relative luminance (WCAG) of a #rrggbb color, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** A design with a light background gets the light ANSI palette. */
export function isLightAppearance(appearance: Appearance): boolean {
  return /^#[0-9a-f]{6}$/i.test(appearance.background) && luminance(appearance.background) > 0.4;
}

export function terminalTheme(appearance: Appearance): ITheme {
  return {
    ...(isLightAppearance(appearance) ? lightAnsiPalette : darkAnsiPalette),
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

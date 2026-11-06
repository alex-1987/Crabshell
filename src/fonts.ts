import { invoke } from "@tauri-apps/api/core";

/** Built-in font stacks, used when no font is chosen in Settings → Fonts. */
export const DEFAULT_UI_FONT = '"Cantarell", "Noto Sans", sans-serif';
export const DEFAULT_TERMINAL_FONT = '"JetBrains Mono", "DejaVu Sans Mono", monospace';

export type FontFamily = { name: string; monospace: boolean };

/**
 * CSS font stack for a chosen family, with the defaults as fallback for missing glyphs.
 * Names are validated by the backend (letters, digits, spaces and -_.&+()), so quoting is safe.
 */
export function fontStack(name: string, fallback: string): string {
  return name ? `"${name}", ${fallback}` : fallback;
}

let cached: Promise<FontFamily[]> | null = null;

/** Installed font families (scanned once per app run by the backend). */
export function listSystemFonts(): Promise<FontFamily[]> {
  cached ??= invoke<FontFamily[]>("system_fonts").catch((error: unknown) => {
    cached = null;
    throw error;
  });
  return cached;
}

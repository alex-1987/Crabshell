import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import type { ThemeMode } from "./terminalTypes";

export const UI_SCALE_MIN = 80;
export const UI_SCALE_MAX = 150;

export const themeModeLabels: Record<ThemeMode, string> = {
  system: "Automatisch (System)",
  light: "Hell",
  dark: "Dunkel",
};

/** Order used by the quick toggle in the top bar. */
export const themeModeCycle: ThemeMode[] = ["system", "light", "dark"];

type ResolvedTheme = "light" | "dark";

function mediaTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Follows the OS color scheme. Tauri reads the GTK setting; the media query is a fallback. */
function useSystemTheme(enabled: boolean): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(mediaTheme);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onMedia = () => setTheme(media.matches ? "light" : "dark");
    media.addEventListener("change", onMedia);

    const appWindow = getCurrentWindow();
    void appWindow.theme()
      .then((value) => { if (!disposed && value) setTheme(value); })
      .catch(() => undefined);
    void appWindow.onThemeChanged(({ payload }) => setTheme(payload))
      .then((stop) => { if (disposed) stop(); else unlisten = stop; })
      .catch(() => undefined);

    return () => {
      disposed = true;
      media.removeEventListener("change", onMedia);
      unlisten?.();
    };
  }, [enabled]);

  return theme;
}

export function useUiTheme(mode: ThemeMode, uiScale: number): void {
  const systemTheme = useSystemTheme(mode === "system");
  const resolved = mode === "system" ? systemTheme : mode;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  useEffect(() => {
    document.documentElement.style.setProperty("--ui-zoom", String(uiScale / 100));
  }, [uiScale]);
}

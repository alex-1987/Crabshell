import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { t } from "./i18n";
import { terminalStore } from "./terminalStore";
import type { AppSettings } from "./terminalTypes";

type Panel = "servers" | "snippets";

type PanelSettings = Pick<AppSettings, "sidebarWidth" | "sidebarCollapsed" | "snippetPanelOpen" | "snippetPanelWidth">;

/** Terminal width (CSS px) kept free before a second side panel is hidden. */
const MIN_TERMINAL_WIDTH = 480;
/** Below this window width the panels overlay the terminal (see styles.css); only one fits. */
const OVERLAY_BREAKPOINT = 760;
const MIN_PANEL_WIDTH = 210;
const MAX_PANEL_WIDTH = 420;

const clampPanelWidth = (width: number) => Math.round(Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width)));

/**
 * Server sidebar (left) and snippet panel (right): open state, widths, resizing and which one
 * stays visible when the window is too narrow for both.
 */
export function usePanelLayout({ enabled, zoom, onPersist }: {
  /** False while settings are loading or broken: the panels then cannot be toggled or resized. */
  enabled: boolean;
  /** UI scale factor (1 = 100 %). */
  zoom: number;
  /** Saves changed panel settings. */
  onPersist: (patch: Partial<PanelSettings>) => void;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [snippetPanelOpen, setSnippetPanelOpen] = useState(false);
  const [snippetPanelWidth, setSnippetPanelWidth] = useState(280);
  /** Which panel wins when both are open but the window is too narrow for both. */
  const [lastOpened, setLastOpened] = useState<Panel>("servers");
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const widthsRef = useRef({ servers: sidebarWidth, snippets: snippetPanelWidth });
  const resizingRef = useRef<Panel | null>(null);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Both panels only stay open side by side when the terminal keeps enough room; otherwise the
  // most recently opened one is shown (the other stays "open" and returns when it fits).
  const bothFit = viewportWidth >= OVERLAY_BREAKPOINT
    && viewportWidth >= (sidebarWidth + snippetPanelWidth + 10 + MIN_TERMINAL_WIDTH) * zoom;
  const bothOpen = !sidebarCollapsed && snippetPanelOpen;
  const showServers = !sidebarCollapsed && (!bothOpen || bothFit || lastOpened === "servers");
  const showSnippets = snippetPanelOpen && (!bothOpen || bothFit || lastOpened === "snippets");

  /** Takes the stored layout (on start). */
  function load(settings: PanelSettings) {
    setSidebarWidth(settings.sidebarWidth);
    setSidebarCollapsed(settings.sidebarCollapsed);
    setSnippetPanelOpen(settings.snippetPanelOpen);
    setSnippetPanelWidth(settings.snippetPanelWidth);
    widthsRef.current = { servers: settings.sidebarWidth, snippets: settings.snippetPanelWidth };
  }

  function toggleServers() {
    if (!enabled) return;
    // Open but pushed aside by the snippet panel (narrow window): bring it to the front.
    if (!sidebarCollapsed && !showServers) return setLastOpened("servers");
    const collapsed = !sidebarCollapsed;
    setSidebarCollapsed(collapsed);
    if (!collapsed) setLastOpened("servers");
    onPersist({ sidebarCollapsed: collapsed });
  }

  function toggleSnippets() {
    if (!enabled) return;
    if (snippetPanelOpen && !showSnippets) return setLastOpened("snippets");
    const open = !snippetPanelOpen;
    setSnippetPanelOpen(open);
    if (open) setLastOpened("snippets");
    onPersist({ snippetPanelOpen: open });
    if (!open) terminalStore.focusActiveTerminal();
  }

  function setWidth(panel: Panel, width: number) {
    const next = clampPanelWidth(width);
    widthsRef.current = { ...widthsRef.current, [panel]: next };
    if (panel === "servers") setSidebarWidth(next);
    else setSnippetPanelWidth(next);
  }

  function persistWidths() {
    onPersist({ sidebarWidth: widthsRef.current.servers, snippetPanelWidth: widthsRef.current.snippets });
  }

  function finishResize() {
    if (!resizingRef.current) return;
    resizingRef.current = null;
    persistWidths();
  }

  /** Props for the drag handle next to a panel (mouse and arrow keys). */
  function resizerProps(panel: Panel) {
    return {
      "aria-controls": panel === "servers" ? "server-sidebar" : "snippet-panel",
      "aria-label": panel === "servers" ? t("sidebar.resize") : t("snippetPanel.resize"),
      "aria-orientation": "vertical" as const,
      "aria-valuemax": MAX_PANEL_WIDTH,
      "aria-valuemin": MIN_PANEL_WIDTH,
      "aria-valuenow": panel === "servers" ? sidebarWidth : snippetPanelWidth,
      className: "sidebar-resizer",
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (!enabled || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
        event.preventDefault();
        // The snippet panel sits on the right, so moving left makes it wider.
        const grow = (event.key === "ArrowRight") === (panel === "servers");
        setWidth(panel, widthsRef.current[panel] + (grow ? 16 : -16));
        persistWidths();
      },
      onLostPointerCapture: finishResize,
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (!enabled) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        resizingRef.current = panel;
        event.preventDefault();
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        if (resizingRef.current === "servers") setWidth("servers", event.clientX);
        else if (resizingRef.current === "snippets") setWidth("snippets", window.innerWidth - event.clientX);
      },
      onPointerUp: finishResize,
      role: "separator",
      tabIndex: 0,
    };
  }

  const shellColumns = [
    ...(showServers ? ["var(--sidebar-col)", "5px"] : []),
    "minmax(0, 1fr)",
    ...(showSnippets ? ["5px", "var(--snippet-col)"] : []),
  ].join(" ");

  return {
    showServers,
    showSnippets,
    load,
    toggleServers,
    toggleSnippets,
    resizerProps,
    shellClassName: `app-shell${showServers ? "" : " sidebar-collapsed"}${showSnippets ? " snippet-panel-open" : ""}`,
    shellStyle: {
      "--sidebar-width": `${sidebarWidth}px`,
      "--snippet-panel-width": `${snippetPanelWidth}px`,
      "--shell-columns": shellColumns,
    } as CSSProperties,
  };
}

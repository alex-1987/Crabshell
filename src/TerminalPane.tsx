import { useEffect, useRef } from "react";
import { t } from "./i18n";
import { terminalStore } from "./terminalStore";

type TerminalPaneProps = {
  tabId: string;
  paneId: string;
};

export default function TerminalPane({ tabId, paneId }: TerminalPaneProps) {
  const elementRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    return terminalStore.attachPane(tabId, paneId, element);
  }, [paneId, tabId]);

  return <div aria-label={t("terminal.pane")} className="terminal-container" ref={elementRef} />;
}

import { useEffect, useRef } from "react";
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

  return <div aria-label="SSH-Terminal" className="terminal-container" ref={elementRef} />;
}

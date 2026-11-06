import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import TabsApp from "./TabsApp";

// No browser context menu ("Reload", "Inspect Element") anywhere in the app. Terminals open
// Crabshell's own menu (handled in the capture phase before this), and text fields keep the
// native one for cut/copy/paste.
window.addEventListener("contextmenu", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("input, textarea, [contenteditable='true']")) return;
  event.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TabsApp />
  </React.StrictMode>,
);

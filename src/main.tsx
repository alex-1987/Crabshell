import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import TabsApp from "./TabsApp";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TabsApp />
  </React.StrictMode>,
);

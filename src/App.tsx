import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "./styles.css";

const HOST_STORAGE_KEY = "crabshell.saved-host.v1";

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "disconnecting" | "failed";

type SessionEvent =
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "disconnected"; message: string }
  | { state: "failed"; message: string };

type SavedHost = {
  host: string;
  username: string;
};

function loadSavedHost(): SavedHost {
  try {
    const value = localStorage.getItem(HOST_STORAGE_KEY);
    if (value) {
      const saved = JSON.parse(value) as Partial<SavedHost>;
      return { host: saved.host ?? "", username: saved.username ?? "" };
    }
  } catch {
    localStorage.removeItem(HOST_STORAGE_KEY);
  }
  return { host: "", username: "" };
}

const statusLabels: Record<ConnectionStatus, string> = {
  disconnected: "Getrennt",
  connecting: "Verbinde",
  connected: "Verbunden",
  disconnecting: "Trenne",
  failed: "Fehler",
};

export default function App() {
  const initialHost = loadSavedHost();
  const [host, setHost] = useState(initialHost.host);
  const [username, setUsername] = useState(initialHost.username);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [activeHost, setActiveHost] = useState("");
  const [notice, setNotice] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionReadyRef = useRef(false);

  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"JetBrains Mono", "DejaVu Sans Mono", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 4000,
      theme: {
        background: "#10120f",
        foreground: "#d8ded2",
        cursor: "#c7e77a",
        cursorAccent: "#10120f",
        selectionBackground: "#65734b88",
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
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    try {
      terminal.loadAddon(new WebglAddon());
    } catch {
      // The DOM renderer remains available when WebGL is unavailable.
    }
    terminalRef.current = terminal;
    terminal.writeln("Crabshell // lokales SSH-Terminal");
    terminal.writeln("OpenSSH übernimmt Schlüssel, Agent und known_hosts.");
    terminal.writeln("");

    let lastSize = "";
    let animationFrame = 0;
    const fitTerminal = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        try {
          fitAddon.fit();
          const size = `${terminal.cols}x${terminal.rows}`;
          const activeSessionId = sessionIdRef.current;
          if (activeSessionId && sessionReadyRef.current && size !== lastSize) {
            lastSize = size;
            void invoke("resize_session", {
              sessionId: activeSessionId,
              cols: terminal.cols,
              rows: terminal.rows,
            }).catch((error: unknown) => setNotice(String(error)));
          }
        } catch {
          return;
        }
      });
    };

    const resizeObserver = new ResizeObserver(fitTerminal);
    resizeObserver.observe(container);
    fitTerminal();

    terminal.onData((data) => {
      const activeSessionId = sessionIdRef.current;
      if (!activeSessionId || !sessionReadyRef.current) return;
      const bytes = new TextEncoder().encode(data);
      void invoke("write_to_session", bytes, {
        headers: { "x-session-id": activeSessionId },
      }).catch((error: unknown) => setNotice(String(error)));
    });

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, []);

  function saveHost() {
    const savedHost = host.trim();
    if (!savedHost) {
      setNotice("Bitte zuerst einen Hostnamen oder SSH-Alias eingeben.");
      return;
    }
    const profile = { host: savedHost, username: username.trim() };
    localStorage.setItem(HOST_STORAGE_KEY, JSON.stringify(profile));
    setHost(profile.host);
    setUsername(profile.username);
    setNotice("Host lokal gespeichert.");
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = host.trim();
    const user = username.trim();
    if (!target || status === "connecting" || status === "connected") return;

    const id = crypto.randomUUID();
    const terminal = terminalRef.current;
    sessionReadyRef.current = false;
    sessionIdRef.current = id;
    setSessionId(id);
    setActiveHost(user ? `${user}@${target}` : target);
    setStatus("connecting");
    setNotice("");
    terminal?.clear();
    terminal?.writeln(`Verbinde mit ${user ? `${user}@` : ""}${target} ...`);

    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = (bytes) => terminalRef.current?.write(new Uint8Array(bytes));
    const onState = new Channel<SessionEvent>();
    onState.onmessage = (event) => {
      setStatus(event.state);
      sessionReadyRef.current = event.state === "connected";
      if (event.state === "connected") {
        const terminal = terminalRef.current;
        if (terminal) {
          void invoke("resize_session", {
            sessionId: id,
            cols: terminal.cols,
            rows: terminal.rows,
          }).catch((error: unknown) => setNotice(String(error)));
        }
      }
      if (event.state === "disconnected") {
        sessionIdRef.current = null;
        setSessionId(null);
        setNotice(event.message);
      } else if (event.state === "failed") {
        sessionIdRef.current = null;
        setSessionId(null);
        setNotice(event.message);
      }
    };

    try {
      await invoke("connect_host", {
        request: {
          sessionId: id,
          host: target,
          username: user || null,
          cols: terminal?.cols ?? 100,
          rows: terminal?.rows ?? 30,
        },
        onData,
        onState,
      });
    } catch (error) {
      if (sessionIdRef.current === id) {
        sessionReadyRef.current = false;
        sessionIdRef.current = null;
        setSessionId(null);
        setStatus("failed");
      }
      const message = String(error);
      setNotice(message);
      terminalRef.current?.writeln(`\r\n[Crabshell] ${message}`);
    }
  }

  async function disconnect() {
    const id = sessionIdRef.current;
    if (!id) return;
    setStatus("disconnecting");
    sessionReadyRef.current = false;
    try {
      await invoke("close_session", { sessionId: id });
      sessionIdRef.current = null;
      setSessionId(null);
      setStatus("disconnected");
      setNotice("Verbindung getrennt.");
    } catch (error) {
      setStatus("failed");
      setNotice(String(error));
    }
  }

  const connected = status === "connected" || status === "connecting" || status === "disconnecting";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div>
            <div className="brand-name">crabshell</div>
            <div className="brand-caption">LOCAL SSH WORKSPACE</div>
          </div>
        </div>

        <div className="privacy-line">
          <span className="privacy-indicator" />
          <span>Nur auf diesem Gerät</span>
        </div>

        <section className="host-panel" aria-labelledby="host-title">
          <div className="section-kicker">
            <h1 id="host-title">Verbindung</h1>
            <span className={`status-led status-${status}`} />
          </div>
          <form onSubmit={connect}>
            <label className="field-label" htmlFor="host">Host oder SSH-Alias</label>
            <input
              autoComplete="off"
              id="host"
              name="host"
              onChange={(event) => setHost(event.target.value)}
              placeholder="z. B. dev-server"
              spellCheck={false}
              value={host}
              required
            />
            <label className="field-label user-label" htmlFor="username">Benutzer <span>optional</span></label>
            <input
              autoComplete="off"
              id="username"
              name="username"
              onChange={(event) => setUsername(event.target.value)}
              placeholder="aus ~/.ssh/config"
              spellCheck={false}
              value={username}
            />
            <div className="form-footnote">Schlüssel und Host-Prüfung übernimmt OpenSSH.</div>
            <button className="button button-primary" disabled={connected || !host.trim()} type="submit">
              <span className="button-glyph" aria-hidden="true">↗</span>
              {status === "connecting" ? "Verbinde ..." : "Verbinden"}
            </button>
            <button className="button button-secondary" disabled={!host.trim()} onClick={saveHost} type="button">
              <span className="button-glyph save-glyph" aria-hidden="true">＋</span>
              Host speichern
            </button>
          </form>
        </section>

        <div className="sidebar-bottom">
          <div className="open-ssh-badge"><span>SSH</span><div><strong>OpenSSH</strong><small>Systeminstallation</small></div></div>
          <div className="sidebar-meta">Keine Cloud · Kein Konto · Keine Telemetrie</div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><span>CRABSHELL</span><i>/</i><strong>TERMINAL</strong></div>
          <div className="topbar-actions">
            <span className={`connection-label label-${status}`}><span className="status-led" />{statusLabels[status]}</span>
            <button className="disconnect-button" disabled={!sessionId} onClick={() => void disconnect()} type="button">
              <span aria-hidden="true">■</span> Trennen
            </button>
          </div>
        </header>

        <section className="terminal-frame" aria-label="SSH-Terminal">
          <div className="terminal-heading">
            <div className="terminal-target">
              <div className="target-icon" aria-hidden="true"><span /></div>
              <div>
                <div className="target-name">{activeHost || host || "Kein Host ausgewählt"}</div>
                <div className="target-subtitle">{activeHost ? "Interaktive Shell" : "Bereit für eine Verbindung"}</div>
              </div>
            </div>
            <div className="transport-tag"><span /> OPENSSH <b>·</b> PTY</div>
          </div>
          <div className="terminal-body">
            <div className="terminal-container" ref={terminalContainerRef} />
          </div>
          <div className="terminal-statusbar">
            <div className="status-message"><span className={`status-led status-${status}`} />{notice || statusLabels[status]}</div>
            <div className="terminal-metrics">{sessionId ? "SESSION AKTIV" : "LOKALE SITZUNG"}<span>UTF-8</span></div>
          </div>
        </section>

        <footer className="workspace-footer">
          <span>Crabshell <b>0.1.0</b></span>
          <span>SSH-Konfiguration und Schlüssel bleiben auf deinem System.</span>
        </footer>
      </main>
    </div>
  );
}

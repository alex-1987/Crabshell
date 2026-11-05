# Crabshell – Anweisungen für den Coding-Agenten

Antworte auf Deutsch. Code, Bezeichner und Code-Kommentare schreibst du auf Englisch.

## Projekt

Crabshell ist ein lokaler SSH-Manager für den Desktop (Alternative zu Termius/Tabby, ohne Cloud, ohne Account, ohne Telemetrie).

- Desktop-App: **Tauri 2**
- Backend: **Rust** (Tokio)
- Terminal im Frontend: **xterm.js** (+ fit- und webgl-Addon)
- Frontend: React + Vite + TypeScript (Paketnamen: `@xterm/xterm`, `@xterm/addon-fit`)
- Zielplattform zuerst: Linux

## Zentrale Architekturentscheidung

Die SSH-Verbindung läuft über das **installierte OpenSSH** (`ssh`) als Unterprozess, angebunden über eine PTY mit dem Crate `portable-pty`.

- Kein `russh` und keine eigene SSH-Implementierung in dieser Phase.
- `~/.ssh/config`, ssh-agent, `known_hosts`, ProxyJump und IdentityFile übernimmt OpenSSH. Baue davon nichts nach.
- Kapsele Sessions hinter einem Trait (z. B. `SshSession` mit `connect`, `write`, `resize`, `close`), damit später eine zweite Implementierung möglich ist, ohne das Frontend zu ändern.

## Roadmap (strikt der Reihenfolge nach)

1. Ein Host: Verbindung per `ssh` über `portable-pty`, Ein- und Ausgabe, Resize, Disconnect, sauberer Lebenszyklus
2. Host-Import aus `~/.ssh/config`
3. Tabs und Split-Panes (eine Session pro Pane)
4. Snippets (einfügen, nicht automatisch senden)
5. SFTP (später, noch nicht anfangen)

**Aktueller Schritt: 1.** Arbeite nur am aktuellen Schritt. Baue nichts aus späteren Schritten vor, es sei denn, ich bitte darum.

## Regeln für den Rust-Code

- Halte niemals einen `Mutex`-Guard über ein `.await`. Hole den Sender oder Handle aus der Map, klone ihn, gib den Lock frei und erst dann `await`.
- Jede Session hat einen expliziten Zustand (z. B. `Connecting`, `Connected`, `Disconnected`, `Failed(reason)`). Zustandswechsel werden als Events ans Frontend gemeldet. Ein beendeter oder fehlgeschlagener Task darf nie stillschweigend verschwinden.
- Beim Schließen eines Panes und beim Beenden der App: Kindprozess beenden, PTY schließen, Session aus der Verwaltung entfernen.
- Fehler als `Result` behandeln. Kein `unwrap()` oder `expect()` im Anwendungscode (nur in Tests).
- Starte `ssh` immer mit einzelnen Argumenten über `CommandBuilder`, nie über `sh -c` oder zusammengesetzte Shell-Strings.
- Validiere Host- und Benutzernamen. Werte, die mit `-` beginnen, dürfen nicht als Option interpretiert werden (nutze `--` vor dem Ziel).
- Im React-Frontend müssen `useEffect`-Cleanups Session, Terminal und Listener freigeben (StrictMode mountet doppelt).
- Reine Logik (z. B. Parser für die SSH-Config) bekommt Unit-Tests.

## Terminal-Transport

- Terminal-Output und -Input gehen als **rohe Bytes** zwischen Rust und Frontend, nicht als JSON-Zahlenarray. Prüfe in der aktuellen Tauri-2-Doku, wie binäre Channel-Daten (z. B. `tauri::ipc::Channel` mit `InvokeResponseBody::Raw`) korrekt verwendet werden, und rate die API nicht.
- Resize: xterm.js meldet `cols`/`rows` an das Backend, das Backend ruft `resize` auf der PTY auf. Teste das tatsächlich (z. B. mit `htop` oder `vim` im Terminal).
- Der Host-Key-Dialog von OpenSSH („unbekannter Host") erscheint in Schritt 1 einfach im Terminal. Ein eigener Dialog kommt später.

## Sicherheit

- Nie `StrictHostKeyChecking=no` oder `UserKnownHostsFile=/dev/null` setzen.
- Keine Passwörter oder Passphrasen im Klartext speichern oder loggen. Zugangsdaten über ssh-agent oder den System-Schlüsselbund (Crate `keyring`).
- Tauri-Capabilities und Permissions so eng wie möglich halten. Keine Shell- oder FS-Rechte freigeben, die nicht gebraucht werden.
- Keine Secrets in Logs, Fehlermeldungen oder Events.

## Snippets (ab Schritt 4)

- Snippets werden über `term.paste(text)` in das aktive Terminal **eingefügt**.
- Hänge nie automatisch einen Zeilenumbruch an. „Einfügen und mit Enter senden" ist eine eigene, bewusste Aktion mit sichtbarer Vorschau.

## Arbeitsweise

- Arbeite in kleinen, nachvollziehbaren Schritten und erkläre kurz, was du geändert hast.
- Frage vor dem Hinzufügen neuer Dependencies nach und begründe sie.
- Erfinde keine APIs. Wenn du dir bei Crate- oder Tauri-Signaturen unsicher bist, schau in die Doku der installierten Version.
- Vor Abschluss einer Aufgabe müssen `cargo fmt`, `cargo clippy` und `cargo check` ohne Fehler und Warnungen durchlaufen. Das Frontend muss mit `npm run build` bauen.
- Halte `README.md` aktuell, wenn sich Setup oder Befehle ändern.

## Befehle

```bash
npm install            # Abhängigkeiten
npm run tauri dev      # App im Entwicklungsmodus
npm run tauri build    # Release-Build
cd src-tauri && cargo fmt && cargo clippy && cargo check
cd src-tauri && cargo test
```

## Fertig-Kriterien für Schritt 1

- Ein gespeicherter Host lässt sich verbinden, im Terminal läuft eine funktionierende Shell
- Eingabe, Ausgabe, Farben und Resize funktionieren (getestet mit `htop`/`vim`)
- Disconnect und Fenster-Schließen beenden den `ssh`-Prozess sauber, es bleiben keine Zombie-Prozesse
- Verbindungsfehler und Trennungen sind in der UI sichtbar
- Der Host-Key-Ablauf läuft über OpenSSH im Terminal
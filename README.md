# Crabshell

Lokaler SSH-Manager für den Desktop, gebaut mit Tauri 2, Rust und xterm.js. Crabshell verwendet das installierte OpenSSH; Schlüssel, ssh-agent, `known_hosts` und `~/.ssh/config` bleiben auf deinem Gerät.

## Aktueller Stand

Crabshell unterstützt mehrere lokal gespeicherte Serverprofile und mehrere Terminal-Tabs mit jeweils eigener SSH-Sitzung:

- Serverliste mit Hinzufügen, Bearbeiten und Entfernen von Profilen
- Terminal-Tabs mit unabhängigen Sessions, Reconnect und Tab-Schließen
- Tastenkürzel: `Ctrl+Shift+T` neuer Tab, `Ctrl+Shift+W` schließen, `Ctrl+Tab` wechseln
- Host oder SSH-Config-Alias und optionaler Benutzer pro Profil
- Optionales Label und Auswahl eines privaten Schlüssels
- Serverprofile in `servers.json` und UI-Einstellungen in `settings.json` im app-spezifischen Tauri-Konfigurationsordner
- OpenSSH in einer PTY mit roher Terminal-Ein- und Ausgabe
- Terminal-Resize, Farben, Disconnect und Statusmeldungen
- Aufräumen der SSH-Sitzung beim Schließen des Fensters

Der private Schlüssel wird nicht kopiert oder ausgelesen; OpenSSH erhält nur den ausgewählten Dateipfad. Vorhandene Browserprofile werden beim ersten Start in `servers.json` migriert. Pane-Splits, SSH-Config-Import, Snippets und SFTP sind noch nicht enthalten.

## Voraussetzungen

- Linux mit installiertem OpenSSH-Client (`ssh`)
- Rust-Toolchain und Node.js mit npm
- Tauri-Linux-Abhängigkeiten: WebKitGTK 4.1, GTK 3, `build-essential`, `curl`, `wget`, `file`, `libxdo-dev`, `libssl-dev`, `librsvg2-dev` und `libayatana-appindicator3-dev`

## Entwicklung

```bash
npm install
npm run tauri dev
```

## Checks und Release

```bash
npm run build
cd src-tauri && cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings && cargo check && cargo test
npm run tauri build
```

Die Host-Prüfung beim ersten Verbindungsaufbau erfolgt im Terminal durch OpenSSH. Bestätige einen Host-Key nur, wenn du den angezeigten Fingerprint geprüft hast.

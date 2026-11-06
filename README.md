# Crabshell

Lokaler SSH-Manager für den Desktop, gebaut mit Tauri 2, Rust und xterm.js. Crabshell verwendet das installierte OpenSSH; Schlüssel, ssh-agent, `known_hosts` und `~/.ssh/config` bleiben auf deinem Gerät.

## Aktueller Stand

Crabshell unterstützt mehrere lokal gespeicherte Serverprofile und mehrere Terminal-Tabs mit jeweils eigener SSH-Sitzung:

- Serverliste mit Hinzufügen, Bearbeiten und Entfernen von Profilen
- Terminal-Tabs mit unabhängigen Sessions, Reconnect und Tab-Schließen
- Farbschema Hell, Dunkel oder Automatisch (System), umschaltbar neben dem Zahnrad; einstellbare Textgröße der Oberfläche (80–150 %)
- Designs pro Serverprofil: Schrift- und Hintergrundfarbe, Cursor, Markierung, Tab-Farbe und Schriftgröße, verwaltet über das Zahnrad oben rechts
- Zwischenablage: `Ctrl+Shift+C` kopieren, `Ctrl+Shift+V` einfügen, optional Kopieren beim Markieren und Bestätigung bei mehrzeiligem Einfügen (gilt auch für Kontextmenü und Mittelklick)
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

Farben der Oberfläche stehen in `src/styles.css`. Nach neuen Farbwerten `python3 scripts/gen-theme-palette.py` ausführen; das Skript ersetzt sie durch Variablen und erzeugt die Hell-Variante in `src/theme-palette.css`.

Die Host-Prüfung beim ersten Verbindungsaufbau erfolgt im Terminal durch OpenSSH. Bestätige einen Host-Key nur, wenn du den angezeigten Fingerprint geprüft hast.

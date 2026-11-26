# Ideen für Crabshell

Gesammelte Ideen für kommende Versionen (Stand: 0.2.8, November 2026). Umgesetzte Punkte sind durchgestrichen und mit ✅ markiert.

**Vorschlag für die nächste Version:** Snippet-Variablen.

## Großer Nutzen, überschaubarer Aufwand

1. ~~**Import aus `~/.ssh/config`:** Hosts als Server vorschlagen und per Häkchen übernehmen.~~ ✅ umgesetzt
2. ~~**Automatisch neu verbinden:** Nach einem Abbruch (Standby, WLAN-Wechsel) „In 5 s neu verbinden“ anbieten, auf Wunsch automatisch.~~ ✅ umgesetzt
3. **Snippet-Variablen** wie `systemctl restart {{dienst}}`, die beim Einfügen kurz abgefragt werden.
4. ~~**Klickbare Links** im Terminal, Öffnen mit Ctrl+Klick.~~ ✅ umgesetzt (ohne Zusatzpaket, über die Link-Schnittstelle von xterm.js)

## Komfort

5. ~~**Tabs umbenennen** per Doppelklick, z. B. „prod-db Logs“.~~ ✅ umgesetzt
6. **Favoriten / zuletzt verwendet** oben in der Serverliste.
7. **In allen Panes gleichzeitig tippen** (Broadcast) im Split View, mit deutlicher Warnanzeige.
8. **Snippets importieren und exportieren** als JSON, auch zum Teilen.
9. ~~**Schriftart wählbar**, dazu Zoom pro Tab mit `Ctrl+Plus` und `Ctrl+Minus`.~~ ✅ umgesetzt (Oberfläche und Terminal getrennt)
10. **Sitzungsdauer** in der Statusleiste („verbunden seit 1 h 12 min“).

## Größere Brocken

11. **Mehr als zwei Panes** pro Tab, z. B. 2×2.
12. **Dateien hochladen:** Eine Datei ins Terminal ziehen lädt sie per `scp` oder SFTP hoch.
13. **Port-Weiterleitungen** (`-L`/`-R`) pro Server speichern und mit einem Klick an- und abschalten.
14. **Terminal-Ausgabe als Textdatei speichern**, z. B. als Protokoll für Wartungsarbeiten.

## Qualität und Projekt

15. **Frontend-Tests:**
    - Vitest für die reinen Funktionen in `keybindings.ts`, `osc52.ts`, `persistence.ts` und `labels.ts`.
    - Playwright-Smoke-Tests für die Oberfläche.
16. ~~**Update-Hinweis:** Beim Start die neueste Release-Version auf GitHub prüfen und dezent anzeigen. Abschaltbar, damit das Versprechen „keine Verbindungen nach außen“ gewahrt bleibt.~~ ✅ umgesetzt in 0.2.8 (standardmäßig aus, Frage in der Anleitung, „Jetzt prüfen“ in den Einstellungen)
17. **Code-Signing für Windows**, damit die SmartScreen-Warnung verschwindet. Kostet Geld, alternativ SignPath für Open-Source-Projekte.

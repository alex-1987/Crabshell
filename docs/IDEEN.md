# Ideen für Crabshell

Gesammelte Ideen für kommende Versionen (Stand: 0.2.6, November 2026). Noch nichts davon ist umgesetzt.

**Vorschlag für die nächste Version:** Import aus `~/.ssh/config`, Suche im Terminal, automatisch neu verbinden und die Erreichbarkeits-Anzeige mit ms.

## Erreichbarkeit / Latenz (ms-Anzeige)

- **Kein echtes ICMP-Ping:** Unter Linux braucht es dafür Sonderrechte, und viele Server oder Firewalls blockieren ICMP.
- **Stattdessen die Zeit für den TCP-Verbindungsaufbau zum SSH-Port messen.** Das ist ein kleiner Rust-Befehl ohne Zusatzrechte, der die laufende Sitzung nicht berührt.
- **Anzeige in der Serverliste:** `● 23 ms` in Grün, Gelb oder Rot, grau für „nicht erreichbar“. Gemessen wird beim Öffnen der Seitenleiste und dann etwa alle 30–60 s, nur für sichtbare Server.
- **Grenzen:**
  - Die Latenz *innerhalb* einer laufenden SSH-Sitzung lässt sich so nicht messen.
  - Bei Aliasen mit `ProxyJump` in `~/.ssh/config` würde der falsche Host gemessen. Diese Server bekommen keine Anzeige.
- **Fazit:** Nützlich als Anzeige „Server ist erreichbar“, nicht als Live-Latenz einer Sitzung.

## Großer Nutzen, überschaubarer Aufwand

1. **Import aus `~/.ssh/config`:** Hosts als Server vorschlagen und per Häkchen übernehmen.
2. **Suche im Terminal** mit `Ctrl+Shift+F`, über das xterm-Addon `@xterm/addon-search`.
3. **Automatisch neu verbinden:** Nach einem Abbruch (Standby, WLAN-Wechsel) „In 5 s neu verbinden“ anbieten, auf Wunsch automatisch.
4. **Snippet-Variablen** wie `systemctl restart {{dienst}}`, die beim Einfügen kurz abgefragt werden.
5. **Klickbare Links** im Terminal über `@xterm/addon-web-links`, Öffnen mit Ctrl+Klick.

## Komfort

6. **Tabs umbenennen** per Doppelklick, z. B. „prod-db Logs“.
7. **Favoriten / zuletzt verwendet** oben in der Serverliste.
8. **In allen Panes gleichzeitig tippen** (Broadcast) im Split View, mit deutlicher Warnanzeige.
9. **Snippets importieren und exportieren** als JSON, auch zum Teilen.
10. **Schriftart wählbar**, dazu Zoom pro Tab mit `Ctrl+Plus` und `Ctrl+Minus`.
11. **Sitzungsdauer** in der Statusleiste („verbunden seit 1 h 12 min“).

## Größere Brocken

12. **Mehr als zwei Panes** pro Tab, z. B. 2×2.
13. **Dateien hochladen:** Eine Datei ins Terminal ziehen lädt sie per `scp` oder SFTP hoch.
14. **Port-Weiterleitungen** (`-L`/`-R`) pro Server speichern und mit einem Klick an- und abschalten.
15. **Terminal-Ausgabe als Textdatei speichern**, z. B. als Protokoll für Wartungsarbeiten.

## Qualität und Projekt

16. **Frontend-Tests:**
    - Vitest für die reinen Funktionen in `keybindings.ts`, `osc52.ts`, `persistence.ts` und `labels.ts`.
    - Playwright-Smoke-Tests für die Oberfläche.
17. **Update-Hinweis:** Beim Start die neueste Release-Version auf GitHub prüfen und dezent anzeigen. Abschaltbar, damit das Versprechen „keine Verbindungen nach außen“ gewahrt bleibt.
18. **Code-Signing für Windows**, damit die SmartScreen-Warnung verschwindet. Kostet Geld, alternativ SignPath für Open-Source-Projekte.

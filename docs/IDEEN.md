# Ideen für Crabshell

Gesammelte Ideen für kommende Versionen (Stand: 0.3.3, November 2026).

**Vorschlag für die nächste Version:** Passwörter im Schlüsselbund, danach die Suche im Terminal.

## Geplant

1. **Passwörter im Schlüsselbund** (KWallet/GNOME Keyring, Windows-Anmeldeinformationen, macOS-Schlüsselbund), eines pro Server, nie in `servers.json`. Crabshell gibt sich OpenSSH selbst als `SSH_ASKPASS` und beantwortet nur Passwortabfragen, einmal pro Verbindung; Host-Key-Fragen und 2FA-Codes bleiben im Terminal. Damit kann sich auch der Dateibrowser per Passwort anmelden.
2. **Suche in der Terminal-Ausgabe** mit `Strg+Umschalt+F`: Suchleiste im Tab, Treffer hervorheben, vor/zurück, Groß/Klein und Regex (xterm-Such-Addon).
3. **Importieren und exportieren** in den Einstellungen: Snippets, Server (mit Kategorien und Designs) und Einstellungen als JSON, einzeln oder zusammen. Gespeicherte Passwörter werden nie exportiert. Beim Import wählen: ergänzen oder ersetzen, Doppelte erkennen.
4. **Known-Hosts-Ansicht:** gespeicherte Host-Keys aus `~/.ssh/known_hosts` ansehen (Host, Schlüsseltyp, Fingerprint) und einzelne entfernen, z. B. nach einer Neuinstallation des Servers („REMOTE HOST IDENTIFICATION HAS CHANGED“). Bei der Fehlermeldung direkt „Alten Schlüssel entfernen“ anbieten.
5. **Sitzungsprotokoll:** die Ausgabe eines Tabs laufend in eine Datei mitschreiben (wie PuTTYs Session Logging), pro Server oder global einschaltbar, eine Datei pro Verbindung, ohne Farb- und Steuerzeichen, optional mit Zeitstempeln. Hinweis im Tab, solange mitgeschrieben wird.

## Offen

1. **Code-Signing für Windows**, damit die SmartScreen-Warnung verschwindet. Kostet Geld, alternativ SignPath für Open-Source-Projekte.
2. **Portweiterleitung pro Server** (`-L`, `-R`, `-D`), z. B. ein Datenbank-Tunnel.
3. **Jump-Host pro Server** (`ProxyJump`), ausgewählt aus den gespeicherten Servern.
4. **Schlüssel auf einen Server übertragen** (wie `ssh-copy-id`).
5. **Mehrere Server auf einmal öffnen:** eine Kategorie als Split-Panes, mit Broadcast.

## Umgesetzt

- ✅ **SFTP-Dateibrowser** in der rechten Leiste: Ordner ansehen, Hoch- und Herunterladen (auch Dateien ins Terminal ziehen), Ordner anlegen, umbenennen, löschen, „Im Terminal öffnen“. Ganze Ordner hoch- und herunterladen, Dateien bearbeiten und nach dem Speichern zurückladen wie bei FileZilla (0.3.0). Noch nicht: Rechte ändern.
- ✅ **In allen Panes gleichzeitig tippen** (Broadcast) im Split View, mit roter Warnanzeige, nie gespeichert.
- ✅ **Terminal-Ausgabe als Textdatei speichern** über das Rechtsklick-Menü.
- ✅ **Import aus `~/.ssh/config`:** Hosts als Server vorschlagen und per Häkchen übernehmen (0.2.14).
- ✅ **Automatisch neu verbinden** nach einem Abbruch, dazu einstellbare Keepalives (0.2.15).
- ✅ **Proxy** (SOCKS5/HTTP) für ausgewählte Server (0.2.15).
- ✅ **Klickbare Links** im Terminal, Öffnen mit Strg+Klick (0.2.16).
- ✅ **Tabs umbenennen** per Doppelklick.
- ✅ **Schriftart wählbar**, dazu Zoom pro Tab mit `Ctrl+Plus` und `Ctrl+Minus` (Oberfläche und Terminal getrennt).
- ✅ **Update-Hinweis:** standardmäßig aus, Frage in der Anleitung, „Jetzt prüfen“ in den Einstellungen (0.2.8).

/**
 * Minimal i18n: English is the reference dictionary; every other language must define
 * the same keys (enforced by the `Record<MessageKey, string>` type).
 * Placeholders use `{name}` and are filled from the params object.
 */

export type Language = "en" | "de";
export type LanguageSetting = "system" | Language;

const en = {
  // Status
  "status.disconnected": "Disconnected",
  "status.connecting": "Connecting",
  "status.connected": "Connected",
  "status.disconnecting": "Disconnecting",
  "status.failed": "Connection error",

  // Sidebar
  "sidebar.hide": "Hide server sidebar",
  "sidebar.show": "Show server sidebar",
  "sidebar.close": "Close server sidebar",
  "sidebar.resize": "Resize server sidebar",
  "sidebar.privacy": "Only on this device",
  "sidebar.servers": "Servers",
  "sidebar.addServer": "Add new server",
  "sidebar.savedServers": "Saved servers",
  "sidebar.loading": "Loading server files …",
  "sidebar.empty": "No servers saved yet",
  "sidebar.key": "Key · {file}",
  "sidebar.removeGroup": "Remove {name}",
  "sidebar.edit": "Edit",
  "sidebar.editServer": "Edit {name}",
  "sidebar.delete": "Delete",
  "sidebar.deleteServer": "Delete {name}",
  "sidebar.remove": "Remove",
  "sidebar.systemInstall": "System installation",
  "sidebar.meta": "No cloud · No account · No telemetry",

  // Notices
  "notice.enterHost": "Please enter a host name or SSH alias first.",
  "notice.serverUpdated": "Server updated.",
  "notice.serverSaved": "Server saved.",
  "notice.serverRemoved": "Server removed.",
  "notice.loadFailed": "Local data could not be loaded: {error}",
  "notice.saveServersFailed": "Server profiles could not be saved: {error}",
  "notice.saveSettingsFailed": "Settings could not be saved: {error}",
  "notice.filePickerFailed": "File selection failed: {error}",
  "notice.copied": "Selection copied to the clipboard.",
  "notice.copyFailed": "Copy failed: {error}",
  "notice.pasteFailed": "Paste failed: {error}",
  "notice.pasteNoSession": "Cannot paste: no active session.",
  "notice.shellExited": "Shell exited.",
  "notice.disconnected": "Disconnected.",
  "notice.closeFailed": "The session could not be closed cleanly.",
  "notice.connectingTo": "Connecting to {target} ...",

  // Top bar
  "topbar.terminal": "TERMINAL",
  "topbar.noSession": "No active session",
  "topbar.restart": "Restart",
  "topbar.reconnect": "Reconnect",
  "topbar.stop": "Stop",
  "topbar.disconnect": "Disconnect",
  "topbar.themeToggle": "Color scheme: {mode}. Click to switch",
  "topbar.themeTitle": "Color scheme: {mode}",
  "topbar.openSettings": "Open settings",
  "topbar.settings": "Settings",

  // Tabs and terminal frame
  "tabs.label": "Terminal tabs",
  "tabs.local": "Local",
  "tabs.localShell": "Local shell",
  "tabs.close": "Close {name}",
  "tabs.closeTitle": "Close tab",
  "tabs.openLocal": "Open local shell",
  "tabs.openLocalTitle": "Open local shell (Ctrl+Shift+T)",
  "tabs.empty": "Pick a server on the left or open a local shell with +.",
  "terminal.panel": "Terminal {name}",
  "terminal.pane": "Terminal",
  "terminal.localSubtitle": "Login shell on this device",
  "terminal.sshSubtitle": "Interactive shell",
  "terminal.local": "LOCAL",
  "terminal.sessionActive": "SESSION ACTIVE",
  "terminal.localSession": "LOCAL SESSION",
  "footer.shortcuts": "Ctrl+Shift+C/V copy/paste · Ctrl+Shift+T local shell · Ctrl+Shift+W close · Ctrl+Tab switch",

  // Paste dialog
  "paste.eyebrow": "CLIPBOARD",
  "paste.title": "Paste multiline text?",
  "paste.cancelLabel": "Cancel paste",
  "paste.summary": "{lines} lines · {chars} characters into",
  "paste.warning": "Line breaks may run commands immediately.",
  "paste.confirm": "Paste",

  // Server dialog
  "server.eyebrow": "SSH PROFILE",
  "server.editTitle": "Edit server",
  "server.addTitle": "Add new server",
  "server.closeDialog": "Close dialog",
  "server.label": "Name / label",
  "server.optional": "optional",
  "server.labelPlaceholder": "e.g. production server",
  "server.host": "Host or SSH alias",
  "server.hostPlaceholder": "e.g. dev-server",
  "server.username": "User",
  "server.usernamePlaceholder": "from ~/.ssh/config",
  "server.privateKey": "Private key",
  "server.noKey": "No key selected",
  "server.chooseFile": "Choose file",
  "server.removeKey": "Remove private key",
  "server.removeKeyTitle": "Remove key",
  "server.pickKeyTitle": "Select private SSH key",
  "server.design": "Design",
  "server.defaultDesign": "Default ({name})",
  "server.editDesigns": "Edit designs",
  "server.footnote": "OpenSSH uses the key directly from your device. On the first connection, the host key check appears in the terminal.",
  "server.saveChanges": "Save changes",
  "server.save": "Save server",

  // Common
  "common.cancel": "Cancel",
  "common.save": "Save",

  // Settings dialog
  "settings.title": "Settings",
  "settings.close": "Close settings",
  "settings.sections": "Settings sections",
  "settings.general": "General",
  "settings.designs": "Designs",
  "settings.display": "Display",
  "settings.language": "Language",
  "settings.languageSystem": "System ({name})",
  "settings.colorScheme": "Color scheme",
  "settings.uiScale": "Interface text size",
  "settings.reset": "Reset",
  "settings.uiScaleHint": "Affects the sidebar, tabs, bars and dialogs. The terminal font size is set per design.",
  "settings.clipboard": "Clipboard",
  "settings.copyOnSelect": "Copy on select",
  "settings.confirmPaste": "Confirm multiline paste",
  "settings.defaultDesign": "Default for servers without their own design",
  "settings.localDesign": "Design for local shells",
  "settings.defaultDesignOption": "Default design",
  "settings.defaultBadge": "Default",
  "settings.duplicate": "Duplicate",
  "settings.copySuffix": "{name} copy",
  "settings.newDesign": "New design",
  "settings.addDesign": "+ New design",
  "settings.unnamed": "Unnamed",
  "settings.name": "Name",
  "settings.foreground": "Text color",
  "settings.background": "Background",
  "settings.cursor": "Cursor",
  "settings.selection": "Selection",
  "settings.tabColor": "Tab color",
  "settings.fontSize": "Font size",
  "settings.previewSelected": "selected text",
  "settings.previewNormal": "normal text",
  "settings.unused": "Not used by any server.",
  "settings.usedBy": "Used by: {names}",
  "settings.localShells": "Local shells",
  "settings.assignHint": "Designs are assigned per profile in the server dialog.",
  "settings.deleteDesign": "Delete design",
  "settings.nameRequired": "Every design needs a name.",

  // Color schemes
  "theme.system": "Automatic (system)",
  "theme.light": "Light",
  "theme.dark": "Dark",
};

export type MessageKey = keyof typeof en;

const de: Record<MessageKey, string> = {
  "status.disconnected": "Getrennt",
  "status.connecting": "Verbinde",
  "status.connected": "Verbunden",
  "status.disconnecting": "Trenne",
  "status.failed": "Verbindungsfehler",

  "sidebar.hide": "Serverleiste ausblenden",
  "sidebar.show": "Serverleiste anzeigen",
  "sidebar.close": "Serverleiste schließen",
  "sidebar.resize": "Breite der Serverleiste ändern",
  "sidebar.privacy": "Nur auf diesem Gerät",
  "sidebar.servers": "Server",
  "sidebar.addServer": "Neuen Server hinzufügen",
  "sidebar.savedServers": "Gespeicherte Server",
  "sidebar.loading": "Serverdateien werden geladen …",
  "sidebar.empty": "Noch keine Server gespeichert",
  "sidebar.key": "Schlüssel · {file}",
  "sidebar.removeGroup": "{name} entfernen",
  "sidebar.edit": "Bearbeiten",
  "sidebar.editServer": "{name} bearbeiten",
  "sidebar.delete": "Löschen",
  "sidebar.deleteServer": "{name} löschen",
  "sidebar.remove": "Entfernen",
  "sidebar.systemInstall": "Systeminstallation",
  "sidebar.meta": "Keine Cloud · Kein Konto · Keine Telemetrie",

  "notice.enterHost": "Bitte zuerst einen Hostnamen oder SSH-Alias eingeben.",
  "notice.serverUpdated": "Server aktualisiert.",
  "notice.serverSaved": "Server gespeichert.",
  "notice.serverRemoved": "Server entfernt.",
  "notice.loadFailed": "Lokale Daten konnten nicht geladen werden: {error}",
  "notice.saveServersFailed": "Serverprofile konnten nicht gespeichert werden: {error}",
  "notice.saveSettingsFailed": "Einstellungen konnten nicht gespeichert werden: {error}",
  "notice.filePickerFailed": "Dateiauswahl fehlgeschlagen: {error}",
  "notice.copied": "Auswahl in die Zwischenablage kopiert.",
  "notice.copyFailed": "Kopieren fehlgeschlagen: {error}",
  "notice.pasteFailed": "Einfügen fehlgeschlagen: {error}",
  "notice.pasteNoSession": "Einfügen nicht möglich: keine aktive Sitzung.",
  "notice.shellExited": "Shell beendet.",
  "notice.disconnected": "Verbindung getrennt.",
  "notice.closeFailed": "Die Sitzung konnte nicht sauber beendet werden.",
  "notice.connectingTo": "Verbinde mit {target} ...",

  "topbar.terminal": "TERMINAL",
  "topbar.noSession": "Keine Sitzung aktiv",
  "topbar.restart": "Neu starten",
  "topbar.reconnect": "Neu verbinden",
  "topbar.stop": "Beenden",
  "topbar.disconnect": "Trennen",
  "topbar.themeToggle": "Farbschema: {mode}. Klicken zum Wechseln",
  "topbar.themeTitle": "Farbschema: {mode}",
  "topbar.openSettings": "Einstellungen öffnen",
  "topbar.settings": "Einstellungen",

  "tabs.label": "Terminal-Tabs",
  "tabs.local": "Lokal",
  "tabs.localShell": "Lokale Shell",
  "tabs.close": "{name} schließen",
  "tabs.closeTitle": "Tab schließen",
  "tabs.openLocal": "Lokale Shell öffnen",
  "tabs.openLocalTitle": "Lokale Shell öffnen (Ctrl+Shift+T)",
  "tabs.empty": "Wähle links einen Server oder öffne mit + eine lokale Shell.",
  "terminal.panel": "Terminal {name}",
  "terminal.pane": "Terminal",
  "terminal.localSubtitle": "Login-Shell auf diesem Gerät",
  "terminal.sshSubtitle": "Interaktive Shell",
  "terminal.local": "LOKAL",
  "terminal.sessionActive": "SESSION AKTIV",
  "terminal.localSession": "LOKALE SITZUNG",
  "footer.shortcuts": "Ctrl+Shift+C/V kopieren/einfügen · Ctrl+Shift+T lokale Shell · Ctrl+Shift+W schließen · Ctrl+Tab wechseln",

  "paste.eyebrow": "ZWISCHENABLAGE",
  "paste.title": "Mehrzeiligen Text einfügen?",
  "paste.cancelLabel": "Einfügen abbrechen",
  "paste.summary": "{lines} Zeilen · {chars} Zeichen in",
  "paste.warning": "Zeilenumbrüche können Befehle sofort ausführen.",
  "paste.confirm": "Einfügen",

  "server.eyebrow": "SSH-PROFIL",
  "server.editTitle": "Server bearbeiten",
  "server.addTitle": "Neuen Server hinzufügen",
  "server.closeDialog": "Dialog schließen",
  "server.label": "Name / Label",
  "server.optional": "optional",
  "server.labelPlaceholder": "z. B. Produktivserver",
  "server.host": "Host oder SSH-Alias",
  "server.hostPlaceholder": "z. B. dev-server",
  "server.username": "Benutzer",
  "server.usernamePlaceholder": "aus ~/.ssh/config",
  "server.privateKey": "Privater Schlüssel",
  "server.noKey": "Kein Schlüssel ausgewählt",
  "server.chooseFile": "Datei wählen",
  "server.removeKey": "Privaten Schlüssel entfernen",
  "server.removeKeyTitle": "Schlüssel entfernen",
  "server.pickKeyTitle": "Privaten SSH-Schlüssel auswählen",
  "server.design": "Design",
  "server.defaultDesign": "Standard ({name})",
  "server.editDesigns": "Designs bearbeiten",
  "server.footnote": "OpenSSH verwendet den Schlüssel direkt von deinem Gerät. Beim ersten Verbinden erscheint die Host-Prüfung im Terminal.",
  "server.saveChanges": "Änderungen speichern",
  "server.save": "Server speichern",

  "common.cancel": "Abbrechen",
  "common.save": "Speichern",

  "settings.title": "Einstellungen",
  "settings.close": "Einstellungen schließen",
  "settings.sections": "Einstellungsbereiche",
  "settings.general": "Allgemein",
  "settings.designs": "Designs",
  "settings.display": "Darstellung",
  "settings.language": "Sprache",
  "settings.languageSystem": "System ({name})",
  "settings.colorScheme": "Farbschema",
  "settings.uiScale": "Textgröße der Oberfläche",
  "settings.reset": "Zurücksetzen",
  "settings.uiScaleHint": "Betrifft Seitenleiste, Tabs, Leisten und Dialoge. Die Schriftgröße im Terminal wird pro Design eingestellt.",
  "settings.clipboard": "Zwischenablage",
  "settings.copyOnSelect": "Beim Markieren kopieren",
  "settings.confirmPaste": "Mehrzeiliges Einfügen bestätigen",
  "settings.defaultDesign": "Standard für Server ohne eigenes Design",
  "settings.localDesign": "Design für lokale Shells",
  "settings.defaultDesignOption": "Standard-Design",
  "settings.defaultBadge": "Standard",
  "settings.duplicate": "Duplizieren",
  "settings.copySuffix": "{name} Kopie",
  "settings.newDesign": "Neues Design",
  "settings.addDesign": "+ Neues Design",
  "settings.unnamed": "Ohne Namen",
  "settings.name": "Name",
  "settings.foreground": "Schriftfarbe",
  "settings.background": "Hintergrund",
  "settings.cursor": "Cursor",
  "settings.selection": "Markierung",
  "settings.tabColor": "Tab-Farbe",
  "settings.fontSize": "Schriftgröße",
  "settings.previewSelected": "markierter Text",
  "settings.previewNormal": "normaler Text",
  "settings.unused": "Von keinem Server verwendet.",
  "settings.usedBy": "Verwendet von: {names}",
  "settings.localShells": "Lokale Shells",
  "settings.assignHint": "Das Design wird im Server-Dialog pro Profil zugewiesen.",
  "settings.deleteDesign": "Design löschen",
  "settings.nameRequired": "Jedes Design braucht einen Namen.",

  "theme.system": "Automatisch (System)",
  "theme.light": "Hell",
  "theme.dark": "Dunkel",
};

/** Native names, shown untranslated so users can always find their language. */
export const languageNames: Record<Language, string> = { en: "English", de: "Deutsch" };
export const languages: Language[] = ["en", "de"];

const dictionaries: Record<Language, Record<MessageKey, string>> = { en, de };

/**
 * The Rust backend reports errors in English. These are the translations for the
 * other languages; unknown messages are shown as they are.
 */
const backendMessages: Partial<Record<Language, Record<string, string>>> = {
  de: {
    "A local Crabshell data file contains invalid JSON": "Eine lokale Crabshell-Datei enthält ungültiges JSON",
    "An appearance contains invalid fields": "Ein Design enthält ungültige Felder",
    "Application closed": "Anwendung geschlossen",
    "A saved server profile contains invalid fields": "Ein gespeichertes Serverprofil enthält ungültige Felder",
    "Could not create a terminal session": "Terminal-Sitzung konnte nicht erstellt werden",
    "Could not create the application config directory": "Konfigurationsordner konnte nicht angelegt werden",
    "Could not encode local Crabshell data": "Lokale Crabshell-Daten konnten nicht kodiert werden",
    "Could not inspect the session process": "Sitzungsprozess konnte nicht geprüft werden",
    "Could not locate the application config directory": "Konfigurationsordner wurde nicht gefunden",
    "Could not open the terminal input stream": "Terminal-Eingabe konnte nicht geöffnet werden",
    "Could not open the terminal output stream": "Terminal-Ausgabe konnte nicht geöffnet werden",
    "Could not read a local Crabshell data file": "Eine lokale Crabshell-Datei konnte nicht gelesen werden",
    "Could not replace local Crabshell data": "Lokale Crabshell-Daten konnten nicht ersetzt werden",
    "Could not resize the terminal": "Terminalgröße konnte nicht geändert werden",
    "Could not start OpenSSH. Check that `ssh` is installed.": "OpenSSH konnte nicht gestartet werden. Ist `ssh` installiert?",
    "Could not start the local shell": "Lokale Shell konnte nicht gestartet werden",
    "Could not start the terminal reader": "Terminal-Ausgabe konnte nicht gestartet werden",
    "Could not stop the session process": "Sitzungsprozess konnte nicht beendet werden",
    "Could not wait for the session process to stop": "Warten auf das Prozessende fehlgeschlagen",
    "Could not write local Crabshell data": "Lokale Crabshell-Daten konnten nicht geschrieben werden",
    "Could not write to the terminal": "Schreiben ins Terminal fehlgeschlagen",
    "Enter a valid host name, address, or SSH config alias": "Gib einen gültigen Hostnamen, eine Adresse oder einen SSH-Config-Alias ein",
    "Enter a valid SSH username": "Gib einen gültigen SSH-Benutzernamen ein",
    "Invalid session identifier": "Ungültige Sitzungskennung",
    "Missing session identifier": "Sitzungskennung fehlt",
    "Session closed": "Sitzung geschlossen",
    "Terminal input is too large": "Terminal-Eingabe ist zu groß",
    "The default appearance does not exist": "Das Standard-Design existiert nicht",
    "The local shell appearance does not exist": "Das Design für lokale Shells existiert nicht",
    "The number of appearances is outside the supported range": "Die Anzahl der Designs liegt außerhalb des erlaubten Bereichs",
    "The selected private key file is unavailable": "Die gewählte Schlüsseldatei ist nicht verfügbar",
    "The session ended": "Die Sitzung wurde beendet",
    "The session is closed": "Die Sitzung ist geschlossen",
    "The session is not open": "Die Sitzung ist nicht geöffnet",
    "The session is unavailable": "Die Sitzung ist nicht verfügbar",
    "The session manager is unavailable": "Die Sitzungsverwaltung ist nicht verfügbar",
    "The terminal size is outside the supported range": "Die Terminalgröße liegt außerhalb des erlaubten Bereichs",
    "The terminal stream ended": "Der Terminal-Datenstrom wurde beendet",
    "The terminal view is no longer available": "Die Terminalansicht ist nicht mehr verfügbar",
    "The terminal view is unavailable": "Die Terminalansicht ist nicht verfügbar",
    "The UI scale is outside the supported range": "Die UI-Skalierung liegt außerhalb des erlaubten Bereichs",
    "This session is already open": "Diese Sitzung ist bereits geöffnet",
    "Too many saved server profiles": "Zu viele gespeicherte Serverprofile",
    "Unknown color scheme": "Unbekanntes Farbschema",
    "Unknown language": "Unbekannte Sprache",
  },
};

let currentLanguage: Language = "en";

export function setLanguage(language: Language): void {
  currentLanguage = language;
  document.documentElement.lang = language;
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = dictionaries[currentLanguage][key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** Translates an error or status message coming from the Rust backend. */
export function translateBackend(message: unknown): string {
  const text = String(message);
  return backendMessages[currentLanguage]?.[text] ?? text;
}

/** Maps a POSIX locale ("de_DE.UTF-8", "de-AT", "C") to a supported language. */
export function languageFromLocale(locale: string | null | undefined): Language | null {
  const code = locale?.trim().toLowerCase().split(/[_.@-]/)[0];
  return languages.find((language) => language === code) ?? null;
}

export function resolveLanguage(setting: LanguageSetting, systemLocale: string | null): Language {
  if (setting !== "system") return setting;
  return languageFromLocale(systemLocale) ?? languageFromLocale(navigator.language) ?? "en";
}

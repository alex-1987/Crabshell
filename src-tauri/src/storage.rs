use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SERVERS_FILE: &str = "servers.json";
const SETTINGS_FILE: &str = "settings.json";
const SESSION_FILE: &str = "session.json";
const MAX_SESSION_TABS: usize = 50;
const MAX_TAB_TITLE_CHARS: usize = 64;
const MAX_SAVED_SERVERS: usize = 500;
const MAX_CATEGORY_CHARS: usize = 48;
const MAX_APPEARANCES: usize = 100;
pub(crate) const DEFAULT_APPEARANCE_ID: &str = "default";
pub(crate) const DEFAULT_SSH_PORT: u16 = 22;

fn default_ssh_port() -> u16 {
    DEFAULT_SSH_PORT
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerProfile {
    pub id: String,
    pub label: String,
    pub host: String,
    /// Older profiles have no port and get the SSH default.
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    pub identity_file: String,
    /// Empty means "use the default appearance".
    #[serde(default)]
    pub appearance_id: String,
    /// Sidebar group; empty means "no category".
    #[serde(default)]
    pub category: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Appearance {
    pub id: String,
    pub name: String,
    pub font_size: u8,
    pub foreground: String,
    pub background: String,
    pub cursor: String,
    pub selection: String,
    pub tab_color: String,
}

impl Appearance {
    fn builtin_default() -> Self {
        Self {
            id: DEFAULT_APPEARANCE_ID.to_string(),
            name: "Crabshell".to_string(),
            font_size: 13,
            foreground: "#d8ded2".to_string(),
            background: "#10120f".to_string(),
            cursor: "#c7e77a".to_string(),
            selection: "#65734b".to_string(),
            tab_color: "#c7e77a".to_string(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct AppSettings {
    pub sidebar_width: u16,
    pub sidebar_collapsed: bool,
    /// Snippet panel on the right side of the window.
    pub snippet_panel_open: bool,
    pub snippet_panel_width: u16,
    /// "single" or "double": clicks needed to open a server from the sidebar.
    pub server_open_click: String,
    /// "single" or "double": clicks needed to paste a snippet from the panel.
    pub snippet_insert_click: String,
    /// Reopen the tabs of the last run on start instead of an empty workspace.
    pub restore_tabs: bool,
    /// Ask before closing the window while terminal sessions are still running.
    pub confirm_close: bool,
    /// Look for a newer release on GitHub at start (one anonymous request). Off until the user
    /// turns it on (welcome guide or settings).
    pub check_updates: bool,
    /// The user answered the update question in the welcome guide (or changed the setting).
    pub updates_asked: bool,
    /// Custom terminal shortcuts: action → key combos (e.g. "Ctrl+Shift+E"). Missing actions use the defaults.
    pub keybindings: BTreeMap<String, Vec<String>>,
    pub copy_on_select: bool,
    pub confirm_multiline_paste: bool,
    /// Plain mouse drags select text even when a program (e.g. micro) uses the mouse.
    pub force_mouse_selection: bool,
    /// Programs may set the clipboard with OSC 52 (write only, never read).
    pub allow_clipboard_write: bool,
    /// OSC 52 clipboard reads: "ask", "always" or "never".
    pub clipboard_read: String,
    pub appearances: Vec<Appearance>,
    pub default_appearance_id: String,
    /// Appearance for local shell tabs; empty means the default appearance.
    pub local_appearance_id: String,
    /// "system", "light" or "dark".
    pub theme_mode: String,
    /// "system" (follow the OS locale), "en" or "de".
    pub language: String,
    /// UI zoom in percent; the terminal font size comes from the appearance instead.
    pub ui_scale: u16,
    /// Font family for the interface; empty means the built-in default.
    pub ui_font: String,
    /// Font family for the terminals; empty means the built-in default.
    pub terminal_font: String,
}

const THEME_MODES: [&str; 3] = ["system", "light", "dark"];
const LANGUAGES: [&str; 3] = ["system", "en", "de"];
const CLIPBOARD_READ_MODES: [&str; 3] = ["ask", "always", "never"];
const CLICK_MODES: [&str; 2] = ["single", "double"];
/// Same list as KEY_ACTIONS in src/keybindings.ts.
const KEY_ACTIONS: [&str; 14] = [
    "copy",
    "paste",
    "snippets",
    "localShell",
    "close",
    "nextTab",
    "previousTab",
    "splitRight",
    "splitDown",
    "otherPane",
    "zoomIn",
    "zoomOut",
    "zoomReset",
    "toggleSidebar",
];
const MAX_BINDINGS_PER_ACTION: usize = 4;
const MAX_COMBO_LEN: usize = 40;

fn valid_combo(combo: &str) -> bool {
    !combo.is_empty() && combo.len() <= MAX_COMBO_LEN && !combo.chars().any(char::is_control)
}

fn valid_keybindings(bindings: &BTreeMap<String, Vec<String>>) -> bool {
    bindings.iter().all(|(action, combos)| {
        KEY_ACTIONS.contains(&action.as_str())
            && combos.len() <= MAX_BINDINGS_PER_ACTION
            && combos.iter().all(|combo| valid_combo(combo))
    })
}

/// Drops unknown actions and invalid combos from an older or hand-edited settings file.
fn normalize_keybindings(bindings: &mut BTreeMap<String, Vec<String>>) {
    bindings.retain(|action, _| KEY_ACTIONS.contains(&action.as_str()));
    for combos in bindings.values_mut() {
        combos.retain(|combo| valid_combo(combo));
        combos.truncate(MAX_BINDINGS_PER_ACTION);
    }
}
const UI_SCALE_RANGE: std::ops::RangeInclusive<u16> = 80..=150;
/// Width of the server sidebar and the snippet panel in px (same limits as usePanelLayout.ts).
const PANEL_WIDTH_RANGE: std::ops::RangeInclusive<u16> = 180..=420;

/// Empty (default) or a font family name that is safe to put into CSS.
fn valid_font(name: &str) -> bool {
    name.is_empty() || (name == name.trim() && crate::fonts::usable_name(name))
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            sidebar_width: 220,
            sidebar_collapsed: false,
            snippet_panel_open: false,
            snippet_panel_width: 220,
            server_open_click: "single".to_string(),
            snippet_insert_click: "single".to_string(),
            restore_tabs: false,
            confirm_close: true,
            check_updates: false,
            updates_asked: false,
            keybindings: BTreeMap::new(),
            copy_on_select: true,
            confirm_multiline_paste: true,
            force_mouse_selection: false,
            allow_clipboard_write: true,
            clipboard_read: "ask".to_string(),
            appearances: vec![Appearance::builtin_default()],
            default_appearance_id: DEFAULT_APPEARANCE_ID.to_string(),
            local_appearance_id: String::new(),
            theme_mode: "dark".to_string(),
            language: "system".to_string(),
            ui_scale: 100,
            ui_font: String::new(),
            terminal_font: String::new(),
        }
    }
}

/// One tab of the last run: a local shell or a saved server (by id, never connection details).
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct SessionTab {
    /// "local" or "ssh".
    pub kind: String,
    pub server_id: String,
    /// Second pane of a split tab: "" (not split), "row" (side by side) or "column" (stacked).
    pub split_direction: String,
    pub split_kind: String,
    pub split_server_id: String,
    /// Name the user gave the tab; empty means the automatic title.
    pub title: String,
    /// Tab color chosen by the user ("#rrggbb"); empty means the color of the design.
    pub color: String,
}

/// Tabs that were open when Crabshell was last used (session.json).
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct SessionState {
    pub tabs: Vec<SessionTab>,
    pub active_index: usize,
}

fn valid_session_pane(kind: &str, server_id: &str) -> bool {
    match kind {
        "local" => server_id.is_empty(),
        "ssh" => !server_id.is_empty() && server_id.len() <= 128,
        _ => false,
    }
}

fn valid_session_tab(tab: &SessionTab) -> bool {
    let split_ok = match tab.split_direction.as_str() {
        "" => tab.split_kind.is_empty() && tab.split_server_id.is_empty(),
        "row" | "column" => valid_session_pane(&tab.split_kind, &tab.split_server_id),
        _ => false,
    };
    let title_ok = tab.title.chars().count() <= MAX_TAB_TITLE_CHARS
        && !tab.title.chars().any(char::is_control);
    let color_ok = tab.color.is_empty() || is_hex_color(&tab.color);
    valid_session_pane(&tab.kind, &tab.server_id) && split_ok && title_ok && color_ok
}

fn normalize_session(mut session: SessionState) -> SessionState {
    session.tabs.retain(valid_session_tab);
    session.tabs.truncate(MAX_SESSION_TABS);
    if session.active_index >= session.tabs.len() {
        session.active_index = 0;
    }
    session
}

pub(crate) fn save_session(app: &AppHandle, session: &SessionState) -> Result<(), String> {
    if session.tabs.len() > MAX_SESSION_TABS {
        return Err("Too many tabs to remember".to_string());
    }
    if !session.tabs.iter().all(valid_session_tab) {
        return Err("Invalid tab in the session".to_string());
    }
    write_json(app, SESSION_FILE, &normalize_session(session.clone()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppData {
    pub servers: Vec<ServerProfile>,
    pub settings: AppSettings,
    pub session: SessionState,
    pub servers_file_exists: bool,
    pub settings_file_exists: bool,
}

pub(crate) fn load_app_data(app: &AppHandle) -> Result<AppData, String> {
    let config_dir = config_dir(app)?;
    let servers_path = config_dir.join(SERVERS_FILE);
    let settings_path = config_dir.join(SETTINGS_FILE);
    let servers_file_exists = servers_path.exists();
    let settings_file_exists = settings_path.exists();

    let servers = read_json::<Vec<ServerProfile>>(&servers_path)?.unwrap_or_default();
    let mut settings = read_json::<AppSettings>(&settings_path)?.unwrap_or_default();
    if !PANEL_WIDTH_RANGE.contains(&settings.sidebar_width) {
        settings.sidebar_width = AppSettings::default().sidebar_width;
    }
    if !PANEL_WIDTH_RANGE.contains(&settings.snippet_panel_width) {
        settings.snippet_panel_width = AppSettings::default().snippet_panel_width;
    }
    normalize_appearances(&mut settings);
    if !THEME_MODES.contains(&settings.theme_mode.as_str()) {
        settings.theme_mode = AppSettings::default().theme_mode;
    }
    if !LANGUAGES.contains(&settings.language.as_str()) {
        settings.language = AppSettings::default().language;
    }
    if !CLIPBOARD_READ_MODES.contains(&settings.clipboard_read.as_str()) {
        settings.clipboard_read = AppSettings::default().clipboard_read;
    }
    if !UI_SCALE_RANGE.contains(&settings.ui_scale) {
        settings.ui_scale = AppSettings::default().ui_scale;
    }
    for font in [&mut settings.ui_font, &mut settings.terminal_font] {
        if !valid_font(font) {
            font.clear();
        }
    }
    if !CLICK_MODES.contains(&settings.server_open_click.as_str()) {
        settings.server_open_click = AppSettings::default().server_open_click;
    }
    if !CLICK_MODES.contains(&settings.snippet_insert_click.as_str()) {
        settings.snippet_insert_click = AppSettings::default().snippet_insert_click;
    }
    normalize_keybindings(&mut settings.keybindings);
    // A missing or broken session file just means "nothing to restore".
    let session = read_json::<SessionState>(&config_dir.join(SESSION_FILE))
        .ok()
        .flatten()
        .map(normalize_session)
        .unwrap_or_default();

    Ok(AppData {
        servers,
        settings,
        session,
        servers_file_exists,
        settings_file_exists,
    })
}

pub(crate) fn save_servers(app: &AppHandle, servers: &[ServerProfile]) -> Result<(), String> {
    validate_servers(servers)?;
    write_json(app, SERVERS_FILE, servers)
}

pub(crate) fn save_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    if !PANEL_WIDTH_RANGE.contains(&settings.sidebar_width) {
        return Err("The sidebar width is outside the supported range".to_string());
    }
    if !PANEL_WIDTH_RANGE.contains(&settings.snippet_panel_width) {
        return Err("The snippet panel width is outside the supported range".to_string());
    }
    if !THEME_MODES.contains(&settings.theme_mode.as_str()) {
        return Err("Unknown color scheme".to_string());
    }
    if !LANGUAGES.contains(&settings.language.as_str()) {
        return Err("Unknown language".to_string());
    }
    if !CLIPBOARD_READ_MODES.contains(&settings.clipboard_read.as_str()) {
        return Err("Unknown clipboard access mode".to_string());
    }
    if !CLICK_MODES.contains(&settings.server_open_click.as_str())
        || !CLICK_MODES.contains(&settings.snippet_insert_click.as_str())
    {
        return Err("Unknown click mode".to_string());
    }
    if !valid_keybindings(&settings.keybindings) {
        return Err("Invalid keyboard shortcut".to_string());
    }
    if !UI_SCALE_RANGE.contains(&settings.ui_scale) {
        return Err("The UI scale is outside the supported range".to_string());
    }
    if !valid_font(&settings.ui_font) || !valid_font(&settings.terminal_font) {
        return Err("Invalid font name".to_string());
    }
    validate_appearances(settings)?;
    write_json(app, SETTINGS_FILE, settings)
}

/// Older settings files have no appearances; make sure the built-in default always exists
/// and the default id points at an existing appearance.
fn normalize_appearances(settings: &mut AppSettings) {
    if !settings
        .appearances
        .iter()
        .any(|appearance| appearance.id == DEFAULT_APPEARANCE_ID)
    {
        settings
            .appearances
            .insert(0, Appearance::builtin_default());
    }
    if !settings
        .appearances
        .iter()
        .any(|appearance| appearance.id == settings.default_appearance_id)
    {
        settings.default_appearance_id = DEFAULT_APPEARANCE_ID.to_string();
    }
    if !settings
        .appearances
        .iter()
        .any(|appearance| appearance.id == settings.local_appearance_id)
    {
        settings.local_appearance_id.clear();
    }
}

fn validate_appearances(settings: &AppSettings) -> Result<(), String> {
    if settings.appearances.is_empty() || settings.appearances.len() > MAX_APPEARANCES {
        return Err("The number of appearances is outside the supported range".to_string());
    }
    let mut ids = std::collections::HashSet::new();
    for appearance in &settings.appearances {
        let colors = [
            &appearance.foreground,
            &appearance.background,
            &appearance.cursor,
            &appearance.selection,
            &appearance.tab_color,
        ];
        if appearance.id.is_empty()
            || appearance.id.len() > 64
            || !ids.insert(appearance.id.as_str())
            || appearance.name.trim().is_empty()
            || appearance.name.len() > 64
            || !(8..=32).contains(&appearance.font_size)
            || !colors.iter().all(|color| is_hex_color(color))
        {
            return Err("An appearance contains invalid fields".to_string());
        }
    }
    if !ids.contains(settings.default_appearance_id.as_str()) {
        return Err("The default appearance does not exist".to_string());
    }
    if !settings.local_appearance_id.is_empty()
        && !ids.contains(settings.local_appearance_id.as_str())
    {
        return Err("The local shell appearance does not exist".to_string());
    }
    Ok(())
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_servers(servers: &[ServerProfile]) -> Result<(), String> {
    if servers.len() > MAX_SAVED_SERVERS {
        return Err("Too many saved server profiles".to_string());
    }

    for server in servers {
        if server.id.is_empty()
            || server.id.len() > 64
            || server.host.trim().is_empty()
            || server.host.len() > 255
            || server.port == 0
            || server.label.len() > 128
            || server.username.len() > 64
            || server.identity_file.len() > 4096
            || server.appearance_id.len() > 64
            || server.category.chars().count() > MAX_CATEGORY_CHARS
            || server.category.trim() != server.category
        {
            return Err("A saved server profile contains invalid fields".to_string());
        }
    }

    Ok(())
}

pub(crate) fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|_| "Could not locate the application config directory".to_string())
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    match fs::read(path) {
        Ok(contents) => serde_json::from_slice(&contents)
            .map(Some)
            .map_err(|_| "A local Crabshell data file contains invalid JSON".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not read a local Crabshell data file".to_string()),
    }
}

fn write_json<T: Serialize + ?Sized>(
    app: &AppHandle,
    file_name: &str,
    value: &T,
) -> Result<(), String> {
    write_json_atomic(&config_dir(app)?.join(file_name), value)
}

/// Writes to a temporary file next to the target and renames it over the target,
/// so a crash mid-write never leaves a truncated data file behind.
pub(crate) fn write_json_atomic<T: Serialize + ?Sized>(
    path: &Path,
    value: &T,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "Could not create the application config directory".to_string())?;
    }
    let temporary_path = temporary_path(path);
    let contents = serde_json::to_vec_pretty(value)
        .map_err(|_| "Could not encode local Crabshell data".to_string())?;
    fs::write(&temporary_path, contents)
        .map_err(|_| "Could not write local Crabshell data".to_string())?;
    fs::rename(&temporary_path, path).map_err(|_| {
        let _ = fs::remove_file(&temporary_path);
        "Could not replace local Crabshell data".to_string()
    })
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut temporary_path = path.to_path_buf();
    temporary_path.set_extension("json.tmp");
    temporary_path
}

#[cfg(test)]
mod tests {
    use super::{
        is_hex_color, normalize_appearances, normalize_session, temporary_path,
        validate_appearances, validate_servers, AppSettings, Appearance, ServerProfile,
        SessionState, SessionTab, DEFAULT_APPEARANCE_ID,
    };
    use std::path::Path;

    #[test]
    fn settings_default_to_a_visible_sidebar() {
        let settings = AppSettings::default();
        assert_eq!(settings.sidebar_width, 220);
        assert!(!settings.sidebar_collapsed);
        assert!(!settings.snippet_panel_open);
        assert_eq!(settings.snippet_panel_width, 220);
        assert!(settings.copy_on_select);
        assert!(settings.confirm_multiline_paste);
        assert!(!settings.force_mouse_selection);
        assert!(settings.allow_clipboard_write);
        assert_eq!(settings.clipboard_read, "ask");
        assert_eq!(settings.theme_mode, "dark");
        assert_eq!(settings.language, "system");
        assert_eq!(settings.ui_scale, 100);
    }

    #[test]
    fn rejects_server_profiles_without_a_host_or_id() {
        let profile = ServerProfile {
            id: String::new(),
            label: String::new(),
            host: String::new(),
            port: 22,
            username: String::new(),
            identity_file: String::new(),
            appearance_id: String::new(),
            category: String::new(),
        };
        assert!(validate_servers(&[profile]).is_err());
    }

    #[test]
    fn validates_server_categories() {
        let mut profile = ServerProfile {
            id: "a".into(),
            label: String::new(),
            host: "h".into(),
            port: 22,
            username: String::new(),
            identity_file: String::new(),
            appearance_id: String::new(),
            category: "Home lab".into(),
        };
        assert!(validate_servers(std::slice::from_ref(&profile)).is_ok());
        profile.category = " padded ".into();
        assert!(validate_servers(std::slice::from_ref(&profile)).is_err());
        profile.category = "x".repeat(49);
        assert!(validate_servers(&[profile]).is_err());
    }

    #[test]
    fn uses_a_temporary_file_next_to_the_target() {
        assert_eq!(
            temporary_path(Path::new("/tmp/servers.json")),
            Path::new("/tmp/servers.json.tmp")
        );
    }

    #[test]
    fn old_server_files_without_appearance_still_load() {
        let profile: ServerProfile = serde_json::from_str(
            r#"{"id":"a","label":"","host":"h","username":"","identityFile":""}"#,
        )
        .unwrap();
        assert!(profile.appearance_id.is_empty());
        assert!(profile.category.is_empty());
        assert_eq!(profile.port, 22);
    }

    #[test]
    fn old_settings_files_get_the_default_appearance() {
        let mut settings: AppSettings =
            serde_json::from_str(r#"{"sidebarWidth":300,"appearances":[]}"#).unwrap();
        normalize_appearances(&mut settings);
        assert_eq!(settings.appearances.len(), 1);
        assert_eq!(settings.default_appearance_id, DEFAULT_APPEARANCE_ID);
        assert!(validate_appearances(&settings).is_ok());
    }

    #[test]
    fn rejects_invalid_appearances() {
        let mut settings = AppSettings::default();
        settings.appearances.push(Appearance {
            name: "Bad".to_string(),
            foreground: "red".to_string(),
            ..settings.appearances[0].clone()
        });
        assert!(
            validate_appearances(&settings).is_err(),
            "duplicate id or bad color"
        );

        let mut settings = AppSettings::default();
        settings.appearances[0].font_size = 99;
        assert!(validate_appearances(&settings).is_err());

        let settings = AppSettings {
            default_appearance_id: "missing".to_string(),
            ..AppSettings::default()
        };
        assert!(validate_appearances(&settings).is_err());
    }

    #[test]
    fn checks_hex_colors() {
        assert!(is_hex_color("#a0B1c2"));
        assert!(!is_hex_color("#abc"));
        assert!(!is_hex_color("a0b1c2f"));
        assert!(!is_hex_color("#gg0000"));
    }

    #[test]
    fn session_drops_invalid_tabs_and_clamps_active_index() {
        let session: SessionState = serde_json::from_str(
            r#"{"tabs":[{"kind":"local"},{"kind":"ssh","serverId":"a"},{"kind":"ssh"},{"kind":"telnet","serverId":"b"}],"activeIndex":7}"#,
        )
        .unwrap();
        let session = normalize_session(session);
        assert_eq!(
            session.tabs,
            vec![
                SessionTab {
                    kind: "local".into(),
                    ..SessionTab::default()
                },
                SessionTab {
                    kind: "ssh".into(),
                    server_id: "a".into(),
                    ..SessionTab::default()
                },
            ]
        );
        assert_eq!(session.active_index, 0);
    }

    #[test]
    fn click_modes_default_to_single_click() {
        let settings: AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.server_open_click, "single");
        assert_eq!(settings.snippet_insert_click, "single");
        assert!(!settings.restore_tabs);
        assert!(settings.confirm_close);
        assert!(!settings.check_updates && !settings.updates_asked);
        assert!(settings.ui_font.is_empty() && settings.terminal_font.is_empty());
    }

    #[test]
    fn session_keeps_valid_splits_only() {
        let session: SessionState = serde_json::from_str(
            r#"{"tabs":[
                {"kind":"ssh","serverId":"a","splitDirection":"row","splitKind":"local"},
                {"kind":"local","splitDirection":"column","splitKind":"ssh","splitServerId":"b"},
                {"kind":"local","splitDirection":"diagonal","splitKind":"local"},
                {"kind":"local","splitDirection":"row","splitKind":"ssh"}
            ]}"#,
        )
        .unwrap();
        let session = normalize_session(session);
        assert_eq!(session.tabs.len(), 2);
        assert_eq!(session.tabs[0].split_direction, "row");
        assert_eq!(session.tabs[1].split_server_id, "b");
    }

    #[test]
    fn session_tab_titles_are_limited() {
        let named = |title: String| super::SessionTab {
            kind: "local".to_string(),
            title,
            ..super::SessionTab::default()
        };
        assert!(super::valid_session_tab(&named("prod-db Logs".to_string())));
        assert!(super::valid_session_tab(&named("ä".repeat(64))));
        assert!(!super::valid_session_tab(&named("x".repeat(65))));
        assert!(!super::valid_session_tab(&named("bad\nname".to_string())));
    }

    #[test]
    fn session_tab_colors_are_hex_or_empty() {
        let colored = |color: &str| super::SessionTab {
            kind: "local".to_string(),
            color: color.to_string(),
            ..super::SessionTab::default()
        };
        assert!(super::valid_session_tab(&colored("")));
        assert!(super::valid_session_tab(&colored("#4f8fe8")));
        assert!(!super::valid_session_tab(&colored("blue")));
        assert!(!super::valid_session_tab(&colored("#4f8fe8ff")));
    }

    #[test]
    fn keybindings_drop_unknown_actions_and_bad_combos() {
        use std::collections::BTreeMap;
        let mut bindings = BTreeMap::new();
        bindings.insert(
            "copy".to_string(),
            vec!["Ctrl+Shift+K".to_string(), String::new()],
        );
        bindings.insert("launchRockets".to_string(), vec!["Ctrl+R".to_string()]);
        bindings.insert("close".to_string(), vec![]);
        assert!(!super::valid_keybindings(&bindings));
        super::normalize_keybindings(&mut bindings);
        assert!(super::valid_keybindings(&bindings));
        assert_eq!(
            bindings.get("copy").unwrap(),
            &vec!["Ctrl+Shift+K".to_string()]
        );
        assert!(bindings.get("close").unwrap().is_empty());
        assert!(!bindings.contains_key("launchRockets"));
    }
}

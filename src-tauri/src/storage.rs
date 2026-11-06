use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SERVERS_FILE: &str = "servers.json";
const SETTINGS_FILE: &str = "settings.json";
const MAX_SAVED_SERVERS: usize = 500;
const MAX_APPEARANCES: usize = 100;
pub(crate) const DEFAULT_APPEARANCE_ID: &str = "default";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerProfile {
    pub id: String,
    pub label: String,
    pub host: String,
    pub username: String,
    pub identity_file: String,
    /// Empty means "use the default appearance".
    #[serde(default)]
    pub appearance_id: String,
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
    pub copy_on_select: bool,
    pub confirm_multiline_paste: bool,
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
}

const THEME_MODES: [&str; 3] = ["system", "light", "dark"];
const LANGUAGES: [&str; 3] = ["system", "en", "de"];
const UI_SCALE_RANGE: std::ops::RangeInclusive<u16> = 80..=150;

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            sidebar_width: 280,
            sidebar_collapsed: false,
            copy_on_select: false,
            confirm_multiline_paste: true,
            appearances: vec![Appearance::builtin_default()],
            default_appearance_id: DEFAULT_APPEARANCE_ID.to_string(),
            local_appearance_id: String::new(),
            theme_mode: "dark".to_string(),
            language: "system".to_string(),
            ui_scale: 100,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppData {
    pub servers: Vec<ServerProfile>,
    pub settings: AppSettings,
    pub servers_file_exists: bool,
    pub settings_file_exists: bool,
}

pub(crate) fn load_app_data(app: &AppHandle) -> Result<AppData, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "Could not locate the application config directory".to_string())?;
    let servers_path = config_dir.join(SERVERS_FILE);
    let settings_path = config_dir.join(SETTINGS_FILE);
    let servers_file_exists = servers_path.exists();
    let settings_file_exists = settings_path.exists();

    let servers = read_json::<Vec<ServerProfile>>(&servers_path)?.unwrap_or_default();
    let mut settings = read_json::<AppSettings>(&settings_path)?.unwrap_or_default();
    if !(210..=420).contains(&settings.sidebar_width) {
        settings.sidebar_width = AppSettings::default().sidebar_width;
    }
    normalize_appearances(&mut settings);
    if !THEME_MODES.contains(&settings.theme_mode.as_str()) {
        settings.theme_mode = AppSettings::default().theme_mode;
    }
    if !LANGUAGES.contains(&settings.language.as_str()) {
        settings.language = AppSettings::default().language;
    }
    if !UI_SCALE_RANGE.contains(&settings.ui_scale) {
        settings.ui_scale = AppSettings::default().ui_scale;
    }

    Ok(AppData {
        servers,
        settings,
        servers_file_exists,
        settings_file_exists,
    })
}

pub(crate) fn save_servers(app: &AppHandle, servers: &[ServerProfile]) -> Result<(), String> {
    validate_servers(servers)?;
    write_json(app, SERVERS_FILE, servers)
}

pub(crate) fn save_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    if !(210..=420).contains(&settings.sidebar_width) {
        return Err("The sidebar width is outside the supported range".to_string());
    }
    if !THEME_MODES.contains(&settings.theme_mode.as_str()) {
        return Err("Unknown color scheme".to_string());
    }
    if !LANGUAGES.contains(&settings.language.as_str()) {
        return Err("Unknown language".to_string());
    }
    if !UI_SCALE_RANGE.contains(&settings.ui_scale) {
        return Err("The UI scale is outside the supported range".to_string());
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
            || server.label.len() > 128
            || server.username.len() > 64
            || server.identity_file.len() > 4096
            || server.appearance_id.len() > 64
        {
            return Err("A saved server profile contains invalid fields".to_string());
        }
    }

    Ok(())
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
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "Could not locate the application config directory".to_string())?;
    fs::create_dir_all(&config_dir)
        .map_err(|_| "Could not create the application config directory".to_string())?;

    let path = config_dir.join(file_name);
    let temporary_path = temporary_path(&path);
    let contents = serde_json::to_vec_pretty(value)
        .map_err(|_| "Could not encode local Crabshell data".to_string())?;
    fs::write(&temporary_path, contents)
        .map_err(|_| "Could not write local Crabshell data".to_string())?;
    fs::rename(&temporary_path, &path)
        .map_err(|_| "Could not replace local Crabshell data".to_string())
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut temporary_path = path.to_path_buf();
    temporary_path.set_extension("json.tmp");
    temporary_path
}

#[cfg(test)]
mod tests {
    use super::{
        is_hex_color, normalize_appearances, temporary_path, validate_appearances,
        validate_servers, AppSettings, Appearance, ServerProfile, DEFAULT_APPEARANCE_ID,
    };
    use std::path::Path;

    #[test]
    fn settings_default_to_a_visible_sidebar() {
        let settings = AppSettings::default();
        assert_eq!(settings.sidebar_width, 280);
        assert!(!settings.sidebar_collapsed);
        assert!(!settings.copy_on_select);
        assert!(settings.confirm_multiline_paste);
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
            username: String::new(),
            identity_file: String::new(),
            appearance_id: String::new(),
        };
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
}

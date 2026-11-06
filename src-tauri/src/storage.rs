use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SERVERS_FILE: &str = "servers.json";
const SETTINGS_FILE: &str = "settings.json";
const MAX_SAVED_SERVERS: usize = 500;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerProfile {
    pub id: String,
    pub label: String,
    pub host: String,
    pub username: String,
    pub identity_file: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct AppSettings {
    pub sidebar_width: u16,
    pub sidebar_collapsed: bool,
    pub copy_on_select: bool,
    pub confirm_multiline_paste: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            sidebar_width: 280,
            sidebar_collapsed: false,
            copy_on_select: false,
            confirm_multiline_paste: true,
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
    write_json(app, SETTINGS_FILE, settings)
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
    use super::{temporary_path, validate_servers, AppSettings, ServerProfile};
    use std::path::Path;

    #[test]
    fn settings_default_to_a_visible_sidebar() {
        let settings = AppSettings::default();
        assert_eq!(settings.sidebar_width, 280);
        assert!(!settings.sidebar_collapsed);
        assert!(!settings.copy_on_select);
        assert!(settings.confirm_multiline_paste);
        assert!(!settings.copy_on_select);
        assert!(settings.confirm_multiline_paste);
    }

    #[test]
    fn rejects_server_profiles_without_a_host_or_id() {
        let profile = ServerProfile {
            id: String::new(),
            label: String::new(),
            host: String::new(),
            username: String::new(),
            identity_file: String::new(),
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
}

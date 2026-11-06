mod desktop;
mod session;
mod sessions;
mod snippets;
mod storage;

use sessions::AppState;
use tauri::Manager;

#[tauri::command]
fn load_persistent_data(app: tauri::AppHandle) -> Result<storage::AppData, String> {
    storage::load_app_data(&app)
}

#[tauri::command]
fn save_servers(app: tauri::AppHandle, servers: Vec<storage::ServerProfile>) -> Result<(), String> {
    storage::save_servers(&app, &servers)
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: storage::AppSettings) -> Result<(), String> {
    storage::save_settings(&app, &settings)
}

#[tauri::command]
fn desktop_integration_status() -> desktop::DesktopIntegration {
    desktop::status()
}

#[tauri::command]
fn desktop_integration_install() -> Result<desktop::DesktopIntegration, String> {
    desktop::install()
}

#[tauri::command]
fn desktop_integration_remove() -> Result<desktop::DesktopIntegration, String> {
    desktop::remove()
}

#[tauri::command]
fn save_session(app: tauri::AppHandle, session: storage::SessionState) -> Result<(), String> {
    storage::save_session(&app, &session)
}

fn snippets_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(storage::config_dir(app)?.join(snippets::SNIPPETS_FILE))
}

#[tauri::command]
fn snippets_list(
    app: tauri::AppHandle,
    store: tauri::State<'_, snippets::SnippetStore>,
) -> Result<snippets::SnippetList, String> {
    store.list(&snippets_path(&app)?)
}

#[tauri::command]
fn snippets_save(
    app: tauri::AppHandle,
    store: tauri::State<'_, snippets::SnippetStore>,
    snippet: snippets::Snippet,
) -> Result<Vec<snippets::Snippet>, String> {
    store.save(&snippets_path(&app)?, snippet)
}

#[tauri::command]
fn snippets_delete(
    app: tauri::AppHandle,
    store: tauri::State<'_, snippets::SnippetStore>,
    id: String,
) -> Result<Vec<snippets::Snippet>, String> {
    store.delete(&snippets_path(&app)?, &id)
}

/// The user's message locale, following the POSIX lookup order
/// (LANGUAGE, LC_ALL, LC_MESSAGES, LANG). Returns None for unset or "C"/"POSIX".
#[tauri::command]
fn system_locale() -> Option<String> {
    locale_from(|name| std::env::var(name).ok())
}

fn locale_from(get: impl Fn(&str) -> Option<String>) -> Option<String> {
    ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(get)
        // LANGUAGE is a colon-separated priority list.
        .filter_map(|value| value.split(':').next().map(str::to_string))
        .find(|value| {
            !value.is_empty() && value != "C" && value != "POSIX" && !value.starts_with("C.")
        })
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(snippets::SnippetStore::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_persistent_data,
            save_session,
            desktop_integration_status,
            desktop_integration_install,
            desktop_integration_remove,
            system_locale,
            save_servers,
            save_settings,
            snippets_list,
            snippets_save,
            snippets_delete,
            sessions::connect_host,
            sessions::open_local_shell,
            sessions::write_to_session,
            sessions::resize_session,
            sessions::close_session
        ])
        .on_window_event(|window, event| {
            // Not on CloseRequested: the frontend may cancel the close to ask first.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<AppState>().close_all();
            }
        })
        .run(tauri::generate_context!())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::locale_from;
    use std::collections::HashMap;

    fn lookup(vars: &[(&str, &str)]) -> Option<String> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        locale_from(|name| vars.get(name).cloned())
    }

    #[test]
    fn follows_posix_locale_priority() {
        assert_eq!(
            lookup(&[("LANG", "de_DE.UTF-8")]).as_deref(),
            Some("de_DE.UTF-8")
        );
        assert_eq!(
            lookup(&[("LANG", "en_US.UTF-8"), ("LC_MESSAGES", "de_AT.UTF-8")]).as_deref(),
            Some("de_AT.UTF-8")
        );
        assert_eq!(
            lookup(&[("LANG", "en_US.UTF-8"), ("LANGUAGE", "de:en")]).as_deref(),
            Some("de")
        );
    }

    #[test]
    fn ignores_neutral_locales() {
        assert_eq!(
            lookup(&[("LC_ALL", "C"), ("LANG", "de_DE.UTF-8")]).as_deref(),
            Some("de_DE.UTF-8")
        );
        assert_eq!(lookup(&[("LANG", "C.UTF-8")]), None);
        assert_eq!(lookup(&[]), None);
    }
}

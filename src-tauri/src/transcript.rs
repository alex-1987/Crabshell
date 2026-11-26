//! "Save output…" in the terminal menu: writes a terminal's text to a file the user picks.
//!
//! The save dialog is opened here, not in the frontend, so the webview never gets to write to
//! a path of its own choosing.

use tauri_plugin_dialog::DialogExt;

/// Scrollback is 4000 rows; even very wide terminals stay far below this.
const MAX_TEXT_BYTES: usize = 32 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 100;

/// Suggested file name: letters, digits, `.`, `-`, `_` only (from a tab title), ending in .txt.
fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|char| {
            if char.is_alphanumeric() || matches!(char, '.' | '-' | '_') {
                char
            } else {
                '-'
            }
        })
        .take(MAX_NAME_CHARS)
        .collect();
    let cleaned = cleaned.trim_matches(['-', '.']);
    let stem = if cleaned.is_empty() {
        "terminal"
    } else {
        cleaned
    };
    if stem.ends_with(".txt") || stem.ends_with(".log") {
        stem.to_string()
    } else {
        format!("{stem}.txt")
    }
}

/// Returns the saved path, or None when the user cancelled the dialog.
/// Async: the dialog blocks until it is closed, which must not happen on the main thread.
#[tauri::command]
pub(crate) async fn save_terminal_output(
    window: tauri::WebviewWindow,
    file_name: String,
    title: String,
    text: String,
) -> Result<Option<String>, String> {
    if text.len() > MAX_TEXT_BYTES {
        return Err("The terminal output is too large to save".to_string());
    }
    let mut dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(title.chars().take(MAX_NAME_CHARS).collect::<String>())
        .set_file_name(safe_file_name(&file_name))
        .add_filter("Text", &["txt", "log"]);
    if let Ok(documents) = tauri::Manager::path(&window).document_dir() {
        dialog = dialog.set_directory(documents);
    }
    let Some(path) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|_| "This location cannot be used".to_string())?;
    std::fs::write(&path, text).map_err(|_| "Could not write the file".to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::safe_file_name;

    #[test]
    fn suggests_safe_file_names() {
        assert_eq!(
            safe_file_name("prod-db-2026-11-26_15-20"),
            "prod-db-2026-11-26_15-20.txt"
        );
        assert_eq!(
            safe_file_name("admin@web 01: logs"),
            "admin-web-01--logs.txt"
        );
        assert_eq!(safe_file_name("../../etc/passwd"), "etc-passwd.txt");
        assert_eq!(safe_file_name("wartung.log"), "wartung.log");
        assert_eq!(safe_file_name("///"), "terminal.txt");
        assert!(safe_file_name(&"x".repeat(500)).len() <= 104);
    }
}

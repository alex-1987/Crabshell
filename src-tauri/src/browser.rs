//! Opens links (release page, GitHub Sponsors) in the default browser.
//!
//! On Linux through GTK with the app window as parent: GTK then passes an activation
//! token (xdg-activation on Wayland, startup notification on X11) to the browser, so the
//! compositor brings the browser window to the front. A plain `xdg-open`, as the opener
//! plugin uses it, carries no token, and KWin, Mutter & co. only flash the browser in the
//! task bar. Elsewhere, and when GTK fails, the opener plugin opens the link.

/// Only links to GitHub (repository, releases, sponsors) are opened.
fn allowed(url: &str) -> bool {
    url.starts_with("https://github.com/")
}

/// Without `async`, Tauri runs the command on the main thread, where GTK must be called.
#[tauri::command]
pub fn open_in_browser(window: tauri::WebviewWindow, url: String) -> Result<(), String> {
    if !allowed(&url) {
        return Err(format!("Refusing to open {url}"));
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(parent) = window.gtk_window() {
            if gtk::show_uri_on_window(Some(&parent), &url, gtk::current_event_time()).is_ok() {
                return Ok(());
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = window;
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn only_github_links() {
        assert!(allowed("https://github.com/sponsors/alex-1987"));
        assert!(allowed(
            "https://github.com/alex-1987/Crabshell/releases/tag/v0.2.9"
        ));
        assert!(!allowed("http://github.com/alex-1987"));
        assert!(!allowed("https://github.com.evil.example/"));
        assert!(!allowed("file:///etc/passwd"));
    }
}

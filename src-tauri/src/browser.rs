//! Opens links in the default browser: Crabshell's own links (release page, GitHub Sponsors)
//! and web links clicked in a terminal (Ctrl+click).
//!
//! On Linux through GTK with the app window as parent: GTK then passes an activation
//! token (xdg-activation on Wayland, startup notification on X11) to the browser, so the
//! compositor brings the browser window to the front. A plain `xdg-open`, as the opener
//! plugin uses it, carries no token, and KWin, Mutter & co. only flash the browser in the
//! task bar. Elsewhere, and when GTK fails, the opener plugin opens the link.

const MAX_LINK_CHARS: usize = 2048;

/// Only links to GitHub (repository, releases, sponsors) are opened.
fn allowed(url: &str) -> bool {
    url.starts_with("https://github.com/")
}

/// Terminal output is untrusted: only web links, never files, programs or other schemes.
fn allowed_terminal_link(url: &str) -> bool {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"));
    rest.is_some_and(|rest| {
        !rest.is_empty()
            && url.len() <= MAX_LINK_CHARS
            && !url
                .chars()
                .any(|char| char.is_whitespace() || char.is_control())
    })
}

/// Without `async`, Tauri runs the command on the main thread, where GTK must be called.
#[tauri::command]
pub fn open_in_browser(window: tauri::WebviewWindow, url: String) -> Result<(), String> {
    if !allowed(&url) {
        return Err("This link cannot be opened".to_string());
    }
    open(&window, &url)
}

/// A link Ctrl+clicked in a terminal.
#[tauri::command]
pub fn open_terminal_link(window: tauri::WebviewWindow, url: String) -> Result<(), String> {
    if !allowed_terminal_link(&url) {
        return Err("This link cannot be opened".to_string());
    }
    open(&window, &url)
}

fn open(window: &tauri::WebviewWindow, url: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(parent) = window.gtk_window() {
            if gtk::show_uri_on_window(Some(&parent), url, gtk::current_event_time()).is_ok() {
                return Ok(());
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = window;
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{allowed, allowed_terminal_link};

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

    #[test]
    fn terminal_links_are_web_links_only() {
        assert!(allowed_terminal_link("https://example.com/path?q=1#top"));
        assert!(allowed_terminal_link("http://10.0.0.5:8080/"));
        assert!(!allowed_terminal_link("https://"));
        assert!(!allowed_terminal_link("file:///etc/passwd"));
        assert!(!allowed_terminal_link("javascript:alert(1)"));
        assert!(!allowed_terminal_link("ftp://example.com/"));
        assert!(!allowed_terminal_link("https://example.com/a b"));
        assert!(!allowed_terminal_link("https://example.com/\u{1b}[31m"));
        assert!(!allowed_terminal_link(&format!(
            "https://{}",
            "a".repeat(2048)
        )));
    }
}

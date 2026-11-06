//! Menu and taskbar integration for the AppImage.
//!
//! Desktops (especially Wayland compositors such as KDE Plasma and GNOME) take a window's
//! taskbar icon from the `.desktop` file whose name or `StartupWMClass` matches the app id
//! (`crabshell`). The .deb/.rpm/pacman packages install one; an AppImage does not, so the
//! user can add one from the settings. Only files in the user's own data directory are
//! written, and only on request.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const DESKTOP_FILE: &str = "crabshell.desktop";
/// Marks entries written by Crabshell so we never touch or remove someone else's file.
const MARKER: &str = "X-Crabshell-AppImage=true";

const ICONS: [(&str, &[u8]); 5] = [
    ("32x32", include_bytes!("../icons/32x32.png")),
    ("64x64", include_bytes!("../icons/64x64.png")),
    ("128x128", include_bytes!("../icons/128x128.png")),
    ("256x256", include_bytes!("../icons/128x128@2x.png")),
    ("512x512", include_bytes!("../icons/icon.png")),
];

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopIntegration {
    /// Running from an AppImage (only then is the integration offered).
    pub app_image: bool,
    /// A Crabshell entry exists in the user's application menu.
    pub installed: bool,
    /// The entry points at the AppImage that is running now.
    pub up_to_date: bool,
}

fn data_home() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("XDG_DATA_HOME").filter(|dir| !dir.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    std::env::var_os("HOME")
        .filter(|dir| !dir.is_empty())
        .map(|home| PathBuf::from(home).join(".local/share"))
        .ok_or_else(|| "Could not find the home directory".to_string())
}

/// Path of the running AppImage, as set by the AppImage runtime.
fn app_image_path() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file())
}

/// Quotes a path for the `Exec` key (Desktop Entry spec: escape `"`, `` ` ``, `$`, `\`; `%` → `%%`).
fn exec_quoted(path: &Path) -> Result<String, String> {
    let text = path
        .to_str()
        .filter(|text| !text.contains(['\n', '\r']))
        .ok_or_else(|| "The AppImage path cannot be used in a menu entry".to_string())?;
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for character in text.chars() {
        match character {
            '"' | '`' | '$' | '\\' => {
                quoted.push('\\');
                quoted.push(character);
            }
            '%' => quoted.push_str("%%"),
            _ => quoted.push(character),
        }
    }
    quoted.push('"');
    Ok(quoted)
}

fn desktop_entry(app_image: &Path) -> Result<String, String> {
    Ok(format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Crabshell\n\
         Comment=Local SSH manager and terminal\n\
         Comment[de]=Lokaler SSH-Manager und Terminal\n\
         Exec={}\n\
         Icon=crabshell\n\
         Terminal=false\n\
         Categories=Development;Network;System;TerminalEmulator;\n\
         Keywords=ssh;terminal;shell;remote;\n\
         StartupWMClass=crabshell\n\
         {MARKER}\n",
        exec_quoted(app_image)?
    ))
}

fn status_in(data_home: &Path, app_image: Option<&Path>) -> DesktopIntegration {
    let existing = fs::read_to_string(data_home.join("applications").join(DESKTOP_FILE)).ok();
    let ours = existing
        .as_deref()
        .is_some_and(|text| text.contains(MARKER));
    let up_to_date = match (existing.as_deref(), app_image) {
        (Some(text), Some(path)) => desktop_entry(path).is_ok_and(|entry| entry == text),
        _ => false,
    };
    DesktopIntegration {
        app_image: app_image.is_some(),
        installed: ours,
        up_to_date,
    }
}

fn install_in(data_home: &Path, app_image: &Path) -> Result<(), String> {
    let applications = data_home.join("applications");
    let desktop_path = applications.join(DESKTOP_FILE);
    if let Ok(existing) = fs::read_to_string(&desktop_path) {
        if !existing.contains(MARKER) {
            return Err("A Crabshell menu entry from a package already exists".to_string());
        }
    }
    for (size, bytes) in ICONS {
        let dir = data_home.join("icons/hicolor").join(size).join("apps");
        fs::create_dir_all(&dir).map_err(|_| "Could not create the icon folder".to_string())?;
        fs::write(dir.join("crabshell.png"), bytes)
            .map_err(|_| "Could not write the Crabshell icon".to_string())?;
    }
    fs::create_dir_all(&applications)
        .map_err(|_| "Could not create the applications folder".to_string())?;
    let temporary = applications.join(format!("{DESKTOP_FILE}.tmp"));
    fs::write(&temporary, desktop_entry(app_image)?)
        .and_then(|()| fs::rename(&temporary, &desktop_path))
        .map_err(|_| "Could not write the menu entry".to_string())
}

fn remove_in(data_home: &Path) -> Result<(), String> {
    let desktop_path = data_home.join("applications").join(DESKTOP_FILE);
    match fs::read_to_string(&desktop_path) {
        Ok(text) if text.contains(MARKER) => {}
        Ok(_) => return Err("The Crabshell menu entry was not created by Crabshell".to_string()),
        Err(_) => return Ok(()),
    }
    fs::remove_file(&desktop_path).map_err(|_| "Could not remove the menu entry".to_string())?;
    for (size, _) in ICONS {
        let _ = fs::remove_file(
            data_home
                .join("icons/hicolor")
                .join(size)
                .join("apps/crabshell.png"),
        );
    }
    Ok(())
}

pub(crate) fn status() -> DesktopIntegration {
    match data_home() {
        Ok(dir) => status_in(&dir, app_image_path().as_deref()),
        Err(_) => DesktopIntegration {
            app_image: false,
            installed: false,
            up_to_date: false,
        },
    }
}

pub(crate) fn install() -> Result<DesktopIntegration, String> {
    let app_image =
        app_image_path().ok_or_else(|| "Crabshell is not running as an AppImage".to_string())?;
    let dir = data_home()?;
    install_in(&dir, &app_image)?;
    Ok(status_in(&dir, Some(&app_image)))
}

pub(crate) fn remove() -> Result<DesktopIntegration, String> {
    let dir = data_home()?;
    remove_in(&dir)?;
    Ok(status_in(&dir, app_image_path().as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("crabshell-desktop-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn quotes_exec_paths() {
        assert_eq!(
            exec_quoted(Path::new("/home/a b/Crab$\"%.AppImage")).unwrap(),
            r#""/home/a b/Crab\$\"%%.AppImage""#
        );
        assert!(exec_quoted(Path::new("/tmp/a\nb")).is_err());
    }

    #[test]
    fn installs_updates_and_removes_only_its_own_entry() {
        let dir = temp_dir("roundtrip");
        let image = dir.join("Crabshell_1.AppImage");
        assert_eq!(
            status_in(&dir, Some(&image)),
            DesktopIntegration {
                app_image: true,
                installed: false,
                up_to_date: false
            }
        );

        install_in(&dir, &image).unwrap();
        assert!(dir
            .join("icons/hicolor/512x512/apps/crabshell.png")
            .is_file());
        assert_eq!(
            status_in(&dir, Some(&image)),
            DesktopIntegration {
                app_image: true,
                installed: true,
                up_to_date: true
            }
        );
        // A newer AppImage in another place makes the entry outdated.
        assert!(!status_in(&dir, Some(&dir.join("Crabshell_2.AppImage"))).up_to_date);

        remove_in(&dir).unwrap();
        assert!(!dir.join("applications").join(DESKTOP_FILE).exists());
        assert!(!dir
            .join("icons/hicolor/512x512/apps/crabshell.png")
            .exists());

        // Entries from packages (without our marker) are left alone.
        fs::write(
            dir.join("applications").join(DESKTOP_FILE),
            "[Desktop Entry]\nName=Crabshell\n",
        )
        .unwrap();
        assert!(install_in(&dir, &image).is_err());
        assert!(remove_in(&dir).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}

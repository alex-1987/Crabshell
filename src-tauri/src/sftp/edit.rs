//! "Edit" in the file browser: the remote file is copied into a folder of its own in the app's
//! cache, opened with the chosen program (or the system default), and watched (notify). When
//! the user saves, the frontend gets "changed" and asks before the copy goes back to the same
//! place on the server.
//!
//! The folder is watched instead of the file: many editors save by writing a new file and
//! renaming it over the old one, which a watch on the file itself would miss.

use std::{
    collections::HashMap,
    hash::{DefaultHasher, Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use notify::{
    event::{AccessKind, AccessMode},
    EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use serde::Serialize;
use tauri::{ipc::Channel, Manager};

use super::{blocking, client::SftpClient, transfer::safe_name, SftpState};

/// Larger files (or binaries) are not opened for editing.
pub(crate) const MAX_EDIT_BYTES: u64 = 5 * 1024 * 1024;
const EDIT_DIR: &str = "edit";
/// Returned when the server copy changed since it was opened; the frontend asks before forcing.
pub(crate) const CHANGED_ON_SERVER: &str = "The file was changed on the server since it was opened";
const UNAVAILABLE: &str = "The edited file is no longer available";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditEvent {
    edit_id: String,
    /// "changed": saved in the editor with new content.
    state: &'static str,
}

struct EditFile {
    /// The folder of its own in the cache (watched, removed on close).
    dir: PathBuf,
    local: PathBuf,
    remote: String,
    /// The server copy as it was when opened or last uploaded.
    remote_modified: Option<u32>,
    remote_size: Option<u64>,
    /// Content hash of the last upload (or download) and of the last "changed" report.
    synced_hash: u64,
    reported_hash: u64,
    channel: Channel<EditEvent>,
}

#[derive(Default)]
pub(crate) struct EditState {
    files: Arc<Mutex<HashMap<String, EditFile>>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    next_id: AtomicU64,
    /// Leftovers of an earlier run are removed once, before the first edit.
    cleaned: AtomicBool,
}

/// Events that can mean new content. Reads (open, access, close after reading) are left out:
/// checking the file reads it, and those reads would come back as events in an endless loop
/// that keeps the watcher busy (a second watch never got through).
fn may_change_content(kind: &EventKind) -> bool {
    match kind {
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        EventKind::Access(_) => false,
        _ => true,
    }
}

fn content_hash(path: &Path) -> Option<u64> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    Some(hasher.finish())
}

/// A program the user chose: an absolute path, or a plain command name found on PATH
/// ("code", "kate"). Never a shell command line.
pub(crate) fn valid_editor(editor: &str) -> bool {
    if editor.is_empty() || editor.len() > 4096 || editor.chars().any(char::is_control) {
        return false;
    }
    Path::new(editor).is_absolute()
        || editor
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || matches!(char, '.' | '_' | '+' | '-'))
            && !editor.starts_with('-')
}

/// Opens the local copy and brings the editor to the front.
///
/// On Linux the program is started through GIO on the GTK main thread with a launch context:
/// GTK then hands it an activation token (xdg-activation on Wayland, startup notification on
/// X11), so KWin, Mutter & co. raise the editor, also when it was already open and only gets a
/// new tab. A plain spawn carries no token and the editor stays in the background.
fn open_in_editor(window: &tauri::WebviewWindow, local: &Path, editor: &str) -> Result<(), String> {
    if !editor.is_empty() && !valid_editor(editor) {
        return Err("The program for editing files is not valid".to_string());
    }
    #[cfg(target_os = "linux")]
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        let (file, program) = (local.to_path_buf(), editor.to_string());
        let dispatched = window.run_on_main_thread(move || {
            let _ = sender.send(launch_with_focus(&file, &program));
        });
        let launched = dispatched.is_ok()
            && receiver
                .recv_timeout(std::time::Duration::from_secs(10))
                .is_ok_and(|result| result.is_ok());
        if launched {
            return Ok(());
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = window;
    plain_open(local, editor)
}

/// GIO launch with a launch context (runs on the GTK main thread).
#[cfg(target_os = "linux")]
fn launch_with_focus(local: &Path, editor: &str) -> Result<(), ()> {
    use gtk::{gdk, gio, gio::prelude::*, glib};
    let context = gdk::Display::default().and_then(|display| display.app_launch_context());
    if let Some(context) = &context {
        context.set_timestamp(gtk::current_event_time());
    }
    let file = gio::File::for_path(local);
    if editor.is_empty() {
        return gio::AppInfo::launch_default_for_uri(&file.uri(), context.as_ref()).map_err(|_| ());
    }
    // GIO reads the command like a desktop file's Exec line and appends the file itself:
    // quote the program, double "%" (field code character).
    let program = glib::shell_quote(editor)
        .to_string_lossy()
        .replace('%', "%%");
    let app = gio::AppInfo::create_from_commandline(
        program,
        None,
        gio::AppInfoCreateFlags::SUPPORTS_STARTUP_NOTIFICATION,
    )
    .map_err(|_| ())?;
    app.launch(&[file], context.as_ref()).map_err(|_| ())
}

/// Opens the file without a launch context (other systems, or when GIO failed).
fn plain_open(local: &Path, editor: &str) -> Result<(), String> {
    if editor.is_empty() {
        return tauri_plugin_opener::open_path(local, None::<&str>)
            .map_err(|_| "No program is set up to open this file".to_string());
    }
    let mut command = if cfg!(target_os = "macos") && editor.ends_with(".app") {
        let mut open = Command::new("open");
        open.args(["-a", editor]);
        open
    } else {
        Command::new(editor)
    };
    command
        .arg(local)
        .spawn()
        .map(|_| ())
        .map_err(|_| "The program for editing files could not be started".to_string())
}

impl EditState {
    fn base_dir(&self, app: &tauri::AppHandle) -> Result<PathBuf, String> {
        let base = app
            .path()
            .app_cache_dir()
            .map_err(|_| "Could not create the local folder".to_string())?
            .join(EDIT_DIR);
        if !self.cleaned.swap(true, Ordering::AcqRel) {
            let _ = std::fs::remove_dir_all(&base);
        }
        Ok(base)
    }

    /// Watches the edit folders; reports a file once per new content that differs from the
    /// server copy.
    fn watch(&self, dir: &Path) -> Result<(), String> {
        let mut watcher = self.watcher.lock().map_err(|_| UNAVAILABLE.to_string())?;
        if watcher.is_none() {
            let files = Arc::clone(&self.files);
            let created =
                notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                    let Ok(event) = event else {
                        return;
                    };
                    if !may_change_content(&event.kind) {
                        return;
                    }
                    let Ok(mut files) = files.lock() else {
                        return;
                    };
                    for (edit_id, file) in files.iter_mut() {
                        if !event
                            .paths
                            .iter()
                            .any(|path| path.parent() == Some(&file.dir))
                        {
                            continue;
                        }
                        let Some(hash) = content_hash(&file.local) else {
                            continue;
                        };
                        if hash != file.synced_hash && hash != file.reported_hash {
                            file.reported_hash = hash;
                            let _ = file.channel.send(EditEvent {
                                edit_id: edit_id.clone(),
                                state: "changed",
                            });
                        }
                    }
                })
                .map_err(|_| "Changes to the file cannot be watched".to_string())?;
            *watcher = Some(created);
        }
        watcher
            .as_mut()
            .ok_or_else(|| UNAVAILABLE.to_string())?
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|_| "Changes to the file cannot be watched".to_string())
    }

    fn remove(&self, edit_id: &str) {
        let file = self
            .files
            .lock()
            .ok()
            .and_then(|mut files| files.remove(edit_id));
        if let Some(file) = file {
            if let Ok(mut watcher) = self.watcher.lock() {
                if let Some(watcher) = watcher.as_mut() {
                    let _ = watcher.unwatch(&file.dir);
                }
            }
            let _ = std::fs::remove_dir_all(&file.dir);
        }
    }

    /// Window closed: stop watching and delete every local copy.
    pub(crate) fn close_all(&self) {
        if let Ok(mut watcher) = self.watcher.lock() {
            watcher.take();
        }
        let files = self
            .files
            .lock()
            .map(|mut files| std::mem::take(&mut *files))
            .unwrap_or_default();
        for file in files.values() {
            let _ = std::fs::remove_dir_all(&file.dir);
        }
    }

    fn file_info(
        &self,
        edit_id: &str,
    ) -> Result<(PathBuf, String, Option<u32>, Option<u64>), String> {
        let files = self.files.lock().map_err(|_| UNAVAILABLE.to_string())?;
        let file = files.get(edit_id).ok_or_else(|| UNAVAILABLE.to_string())?;
        Ok((
            file.local.clone(),
            file.remote.clone(),
            file.remote_modified,
            file.remote_size,
        ))
    }
}

/// Downloads the file into its own cache folder, opens it and starts watching it.
#[tauri::command]
pub(crate) async fn sftp_edit(
    window: tauri::WebviewWindow,
    id: String,
    remote_path: String,
    editor: String,
    on_event: Channel<EditEvent>,
    sftp: tauri::State<'_, SftpState>,
    edits: tauri::State<'_, EditState>,
) -> Result<String, String> {
    let client = sftp.client(&id)?;
    let name = super::file_name(&remote_path);
    if !safe_name(&name) {
        return Err("This name cannot be used on this computer".to_string());
    }
    let number = edits.next_id.fetch_add(1, Ordering::Relaxed);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_millis())
        .unwrap_or(0);
    let edit_id = format!("edit-{stamp}-{number}");
    let dir = edits.base_dir(window.app_handle())?.join(&edit_id);
    let local = dir.join(&name);

    let (download_dir, download_local, remote) = (dir.clone(), local.clone(), remote_path.clone());
    let attrs =
        blocking(move || download_for_edit(&client, &remote, &download_dir, &download_local))
            .await?;
    let hash = content_hash(&local).unwrap_or(0);
    edits
        .files
        .lock()
        .map_err(|_| UNAVAILABLE.to_string())?
        .insert(
            edit_id.clone(),
            EditFile {
                dir: dir.clone(),
                local: local.clone(),
                remote: remote_path,
                remote_modified: attrs.0,
                remote_size: attrs.1,
                synced_hash: hash,
                reported_hash: hash,
                channel: on_event,
            },
        );
    let opened = edits
        .watch(&dir)
        .and_then(|()| open_in_editor(&window, &local, &editor));
    if let Err(error) = opened {
        edits.remove(&edit_id);
        return Err(error);
    }
    Ok(edit_id)
}

/// Checks the size, then copies the remote file; returns its modification time and size.
fn download_for_edit(
    client: &SftpClient,
    remote: &str,
    dir: &Path,
    local: &Path,
) -> Result<(Option<u32>, Option<u64>), String> {
    let attrs = client.stat(remote)?;
    if attrs.is_dir() {
        return Err("Folders cannot be edited".to_string());
    }
    if attrs.size.unwrap_or(0) > MAX_EDIT_BYTES {
        return Err("Only files up to 5 MB can be edited".to_string());
    }
    std::fs::create_dir_all(dir).map_err(|_| "Could not create the local folder".to_string())?;
    let cancel = AtomicBool::new(false);
    client.download(remote, local, &cancel, &mut |_| {})?;
    Ok((attrs.modified, attrs.size))
}

/// Opens the local copy again (the editor was closed or is behind other windows).
/// Async: the launch waits for the GTK main thread, which a sync command would block.
#[tauri::command]
pub(crate) async fn sftp_edit_show(
    window: tauri::WebviewWindow,
    edit_id: String,
    editor: String,
    edits: tauri::State<'_, EditState>,
) -> Result<(), String> {
    let (local, ..) = edits.file_info(&edit_id)?;
    open_in_editor(&window, &local, &editor)
}

/// Copies the edited file back to where it came from. Without `force` it refuses when the
/// server copy changed meanwhile (CHANGED_ON_SERVER). Owner and permissions stay as they are:
/// the existing file is overwritten, not replaced.
#[tauri::command]
pub(crate) async fn sftp_edit_upload(
    id: String,
    edit_id: String,
    force: bool,
    sftp: tauri::State<'_, SftpState>,
    edits: tauri::State<'_, EditState>,
) -> Result<(), String> {
    let client = sftp.client(&id)?;
    let (local, remote, modified, size) = edits.file_info(&edit_id)?;
    let hash = content_hash(&local).ok_or_else(|| "Could not read the local file".to_string())?;
    let upload_local = local.clone();
    let attrs = blocking(move || {
        if !force {
            // A file deleted on the server counts as changed too.
            let current = client.stat(&remote).ok();
            let unchanged = current
                .as_ref()
                .is_some_and(|attrs| attrs.modified == modified && attrs.size == size);
            if !unchanged {
                return Err(CHANGED_ON_SERVER.to_string());
            }
        }
        let cancel = AtomicBool::new(false);
        client.upload(&upload_local, &remote, &cancel, &mut |_| {})?;
        client.stat(&remote)
    })
    .await?;
    let mut files = edits.files.lock().map_err(|_| UNAVAILABLE.to_string())?;
    if let Some(file) = files.get_mut(&edit_id) {
        file.remote_modified = attrs.modified;
        file.remote_size = attrs.size;
        file.synced_hash = hash;
        file.reported_hash = hash;
    }
    Ok(())
}

/// Stops editing: no more watching, the local copy is deleted.
#[tauri::command]
pub(crate) fn sftp_edit_close(edit_id: String, edits: tauri::State<'_, EditState>) {
    edits.remove(&edit_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editors_are_paths_or_plain_names() {
        assert!(valid_editor("code"));
        assert!(valid_editor("gnome-text-editor"));
        assert!(valid_editor("/usr/bin/kate"));
        assert!(!valid_editor(""));
        assert!(!valid_editor("code --wait"));
        assert!(!valid_editor("rm -rf ~"));
        assert!(!valid_editor("-x"));
        assert!(!valid_editor("bin/kate"));
        assert!(!valid_editor("/usr/bin/kate\n"));
    }

    /// Saving in an editor (directly, or by renaming a new file over the old one) is reported
    /// once per new content; saving the unchanged content is not.
    #[test]
    fn reports_saves_including_atomic_renames() {
        use std::sync::mpsc;
        use std::time::Duration;

        let dir = std::env::temp_dir().join(format!("crabshell-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let local = dir.join("nginx.conf");
        std::fs::write(&local, "listen 80;").unwrap();
        let hash = content_hash(&local).unwrap();

        let (sender, receiver) = mpsc::channel();
        let sender = Mutex::new(sender);
        let channel = Channel::new(move |_| {
            let _ = sender.lock().map(|sender| sender.send(()));
            Ok(())
        });
        let state = EditState::default();
        state.files.lock().unwrap().insert(
            "e1".into(),
            EditFile {
                dir: dir.clone(),
                local: local.clone(),
                remote: "/etc/nginx.conf".into(),
                remote_modified: None,
                remote_size: None,
                synced_hash: hash,
                reported_hash: hash,
                channel,
            },
        );
        state.watch(&dir).unwrap();
        let wait = || receiver.recv_timeout(Duration::from_secs(3)).is_ok();
        let quiet = || receiver.recv_timeout(Duration::from_millis(400)).is_err();

        std::fs::write(&local, "listen 80;").unwrap();
        assert!(quiet(), "same content is not a change");
        std::fs::write(&local, "listen 8080;").unwrap();
        assert!(wait(), "direct save");
        while receiver.try_recv().is_ok() {}
        let temp = dir.join(".nginx.conf.swp");
        std::fs::write(&temp, "listen 9090;").unwrap();
        std::fs::rename(&temp, &local).unwrap();
        assert!(wait(), "save by rename");

        state.remove("e1");
        assert!(!dir.exists(), "the local copy is deleted");
    }

    /// Checking a file reads it; those reads must not come back as events (endless loop).
    #[test]
    fn reading_the_file_does_not_feed_back() {
        use std::sync::atomic::AtomicUsize;
        let dir = std::env::temp_dir().join(format!("crabshell-loop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("f.txt");
        std::fs::write(&file, "x").unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&count);
        let target = file.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if event.is_ok_and(|event| may_change_content(&event.kind)) {
                    seen.fetch_add(1, Ordering::Relaxed);
                    let _ = content_hash(&target);
                }
            })
            .unwrap();
        watcher.watch(&dir, RecursiveMode::NonRecursive).unwrap();
        let _ = std::fs::read(&file);
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(count.load(Ordering::Relaxed), 0, "a read is no change");
        std::fs::write(&file, "y").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let after_write = count.load(Ordering::Relaxed);
        assert!(
            (1..10).contains(&after_write),
            "one save, a few events: {after_write}"
        );
        drop(watcher);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn watches_two_files_at_once() {
        use std::sync::mpsc;
        use std::time::Duration;
        let base = std::env::temp_dir().join(format!("crabshell-two-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (sender, receiver) = mpsc::channel::<String>();
        let state = EditState::default();
        for id in ["a", "b"] {
            let dir = base.join(id);
            std::fs::create_dir_all(&dir).unwrap();
            let local = dir.join("f.txt");
            std::fs::write(&local, "x").unwrap();
            let hash = content_hash(&local).unwrap();
            let sender = Mutex::new(sender.clone());
            let name = id.to_string();
            let channel = Channel::new(move |_| {
                let _ = sender.lock().map(|sender| sender.send(name.clone()));
                Ok(())
            });
            state.files.lock().unwrap().insert(
                id.into(),
                EditFile {
                    dir: dir.clone(),
                    local,
                    remote: String::new(),
                    remote_modified: None,
                    remote_size: None,
                    synced_hash: hash,
                    reported_hash: hash,
                    channel,
                },
            );
            state.watch(&dir).unwrap();
        }
        std::fs::write(base.join("b/f.txt"), "changed b").unwrap();
        assert_eq!(receiver.recv_timeout(Duration::from_secs(3)).unwrap(), "b");
        std::fs::write(base.join("a/f.txt"), "changed a").unwrap();
        assert_eq!(receiver.recv_timeout(Duration::from_secs(3)).unwrap(), "a");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn hashes_change_with_the_content() {
        let dir = std::env::temp_dir().join(format!("crabshell-edit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.conf");
        std::fs::write(&file, "listen 80;").unwrap();
        let first = content_hash(&file).unwrap();
        std::fs::write(&file, "listen 8080;").unwrap();
        assert_ne!(content_hash(&file).unwrap(), first);
        assert!(content_hash(&dir.join("missing")).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

//! File browser: SFTP over OpenSSH's sftp subsystem (`ssh -o BatchMode=yes … -s -- host sftp`).
//! OpenSSH still does transport, login, ~/.ssh/config, ProxyJump and known_hosts; Crabshell only
//! speaks the file protocol (protocol.rs) over the process' stdin/stdout (client.rs).
//!
//! The webview never picks a local path to write: downloads go through a save dialog opened
//! here. Uploads read local files the user dropped or picked; they must be absolute paths to
//! existing regular files.

mod client;
pub(crate) mod edit;
mod protocol;
mod transfer;

use std::{
    collections::HashMap,
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri_plugin_dialog::DialogExt;

use client::{SftpClient, Throttle, CANCELLED};
use protocol::FileEntry;

use crate::session::{validate_host, validate_identity_file, validate_username};

const STATE_UNAVAILABLE: &str = "The file browser is unavailable";
const NOT_CONNECTED: &str = "The file connection is closed";
const MAX_UPLOAD_FILES: usize = 500;

#[derive(Default)]
pub(crate) struct SftpState {
    connections: Mutex<HashMap<String, Arc<SftpClient>>>,
    transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
    next_id: AtomicU64,
}

impl SftpState {
    fn client(&self, id: &str) -> Result<Arc<SftpClient>, String> {
        let client = self
            .connections
            .lock()
            .map_err(|_| STATE_UNAVAILABLE.to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| NOT_CONNECTED.to_string())?;
        if !client.is_alive() {
            return Err("The file connection was lost".to_string());
        }
        Ok(client)
    }

    /// Registers a transfer, so it can be cancelled.
    fn start_transfer(&self, transfer_id: &str) -> Result<Arc<AtomicBool>, String> {
        let cancel = Arc::new(AtomicBool::new(false));
        self.transfers
            .lock()
            .map_err(|_| STATE_UNAVAILABLE.to_string())?
            .insert(transfer_id.to_string(), Arc::clone(&cancel));
        Ok(cancel)
    }

    fn end_transfer(&self, transfer_id: &str) {
        if let Ok(mut transfers) = self.transfers.lock() {
            transfers.remove(transfer_id);
        }
    }

    /// Ends every connection (window closed).
    pub(crate) fn close_all(&self) {
        if let Ok(mut transfers) = self.transfers.lock() {
            for cancel in transfers.values() {
                cancel.store(true, Ordering::Relaxed);
            }
            transfers.clear();
        }
        let connections = self
            .connections
            .lock()
            .map(|mut map| std::mem::take(&mut *map))
            .unwrap_or_default();
        for client in connections.values() {
            client.shutdown();
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SftpConnectRequest {
    host: String,
    port: Option<u16>,
    username: Option<String>,
    identity_file: Option<String>,
    #[serde(default)]
    proxy: Option<crate::proxy::ProxyConfig>,
    #[serde(default)]
    keepalive_seconds: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SftpConnection {
    id: String,
    /// Absolute path of the login directory.
    home: String,
}

/// Progress of one item of a transfer: a file, or a folder with everything in it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferEvent {
    /// Name of the file or folder (without the folder it is in).
    file: String,
    /// The file being copied right now, e.g. "site/css/a.css" (same as `file` for one file).
    current: String,
    bytes: u64,
    total: u64,
    /// "running", "done", "failed" or "cancelled".
    state: &'static str,
    /// Files that could not be copied (or were left out) while the rest went on.
    failed: u32,
    error: Option<String>,
}

fn file_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

/// Runs blocking SFTP work off the async runtime's threads.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| STATE_UNAVAILABLE.to_string())?
}

/// `ssh` for the sftp subsystem: never asks for anything (BatchMode), so a login that needs a
/// password or an unknown host key fails with a message instead of hanging.
fn sftp_command(request: &SftpConnectRequest) -> Result<Command, String> {
    let host = request.host.trim();
    validate_host(host)?;
    let username = request
        .username
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());
    if let Some(username) = username {
        validate_username(username)?;
    }
    let identity_file = request
        .identity_file
        .as_deref()
        .filter(|path| !path.is_empty());
    validate_identity_file(identity_file)?;
    let options = crate::conntest::ssh_options(
        request.proxy.as_ref(),
        request.keepalive_seconds,
        host,
        request.port,
        username,
    )?;
    let mut command = Command::new("ssh");
    command.args(["-o", "BatchMode=yes", "-s"]);
    command.args(crate::session::ssh_target_args(
        host,
        request.port,
        username,
        identity_file,
        &options,
    ));
    command.arg("sftp");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashing up.
        command.creation_flags(0x0800_0000);
    }
    Ok(command)
}

#[tauri::command]
pub(crate) async fn sftp_connect(
    request: SftpConnectRequest,
    state: tauri::State<'_, SftpState>,
) -> Result<SftpConnection, String> {
    let (client, home) = blocking(move || {
        let client = SftpClient::start(sftp_command(&request)?, crate::session::SSH_MISSING)?;
        let home = client.realpath(".")?;
        Ok((client, home))
    })
    .await?;
    let id = format!("sftp-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    state
        .connections
        .lock()
        .map_err(|_| STATE_UNAVAILABLE.to_string())?
        .insert(id.clone(), Arc::new(client));
    Ok(SftpConnection { id, home })
}

#[tauri::command]
pub(crate) fn sftp_disconnect(id: String, state: tauri::State<'_, SftpState>) {
    let client = state
        .connections
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&id));
    if let Some(client) = client {
        client.shutdown();
    }
}

#[tauri::command]
pub(crate) async fn sftp_list(
    id: String,
    path: String,
    state: tauri::State<'_, SftpState>,
) -> Result<Vec<FileEntry>, String> {
    let client = state.client(&id)?;
    blocking(move || client.list_dir(&path)).await
}

/// Absolute, normalized path (resolves "..", "~"-less relative paths from the home directory).
#[tauri::command]
pub(crate) async fn sftp_realpath(
    id: String,
    path: String,
    state: tauri::State<'_, SftpState>,
) -> Result<String, String> {
    let client = state.client(&id)?;
    blocking(move || {
        let resolved = client.realpath(&path)?;
        if !client.stat(&resolved)?.is_dir() {
            return Err("This is not a folder".to_string());
        }
        Ok(resolved)
    })
    .await
}

#[tauri::command]
pub(crate) async fn sftp_mkdir(
    id: String,
    path: String,
    state: tauri::State<'_, SftpState>,
) -> Result<(), String> {
    let client = state.client(&id)?;
    blocking(move || client.mkdir(&path)).await
}

/// Renames within the server; fails when the target exists (SFTP v3 never overwrites here).
#[tauri::command]
pub(crate) async fn sftp_rename(
    id: String,
    from: String,
    to: String,
    state: tauri::State<'_, SftpState>,
) -> Result<(), String> {
    let client = state.client(&id)?;
    blocking(move || {
        if client.exists(&to)? {
            return Err("A file or folder with this name already exists".to_string());
        }
        client.rename(&from, &to)
    })
    .await
}

/// Moves a file or folder into `to_dir` on the same server (keeps its name). Fails when the
/// name is taken there or a folder would go into itself. Returns the new path.
#[tauri::command]
pub(crate) async fn sftp_move(
    id: String,
    from: String,
    to_dir: String,
    state: tauri::State<'_, SftpState>,
) -> Result<String, String> {
    let client = state.client(&id)?;
    let target = move_target(&from, &to_dir)?;
    blocking(move || {
        if client.exists(&target)? {
            return Err("A file or folder with this name already exists".to_string());
        }
        client.rename(&from, &target)?;
        Ok(target)
    })
    .await
}

/// Where `from` lands in `to_dir`; refuses a folder going into itself and staying in place.
fn move_target(from: &str, to_dir: &str) -> Result<String, String> {
    let from = from.trim_end_matches('/');
    let to_dir = to_dir.trim_end_matches('/');
    let name = file_name(from);
    if from.is_empty() || !transfer::safe_name(&name) {
        return Err("This name cannot be used".to_string());
    }
    if to_dir == from || to_dir.starts_with(&format!("{from}/")) {
        return Err("A folder cannot be moved into itself".to_string());
    }
    let target = format!("{to_dir}/{name}");
    if target == from {
        return Err("The file is already in this folder".to_string());
    }
    Ok(target)
}

/// Copies a file or folder from one server into `to_dir` on another (or the same) server,
/// streamed through the app. Existing folders are merged, files with the same name replaced.
/// With `delete_source` (moving between servers) the source is deleted, but only when every
/// file arrived.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn sftp_copy(
    from_id: String,
    from: String,
    is_dir: bool,
    to_id: String,
    to_dir: String,
    delete_source: bool,
    transfer_id: String,
    on_progress: Channel<TransferEvent>,
    state: tauri::State<'_, SftpState>,
) -> Result<(), String> {
    let source = state.client(&from_id)?;
    let dest = state.client(&to_id)?;
    // On the same server the copy must not land on the original (it would be emptied) or
    // inside it (it would never end).
    if from_id == to_id {
        move_target(&from, &to_dir)?;
    }
    let name = file_name(from.trim_end_matches('/'));
    let cancel = state.start_transfer(&transfer_id)?;
    let result = blocking(move || {
        let copied = run_item(
            &on_progress,
            &name,
            &cancel,
            || transfer::plan_remote_copy(&source, &from, is_dir, &to_dir),
            |plan, report| transfer::run_remote_copy(&source, &dest, plan, &cancel, report),
        );
        if copied && delete_source {
            source
                .remove_tree(&from)
                .map_err(|_| "Copied, but the original could not be deleted".to_string())?;
        }
        Ok(())
    })
    .await;
    state.end_transfer(&transfer_id);
    result
}

/// Deletes a file, or a folder only when it is empty.
#[tauri::command]
pub(crate) async fn sftp_remove(
    id: String,
    path: String,
    is_dir: bool,
    state: tauri::State<'_, SftpState>,
) -> Result<(), String> {
    let client = state.client(&id)?;
    blocking(move || {
        if is_dir {
            client
                .rmdir(&path)
                .map_err(|_| "The folder could not be deleted (it must be empty)".to_string())
        } else {
            client.remove(&path)
        }
    })
    .await
}

/// The paths that already exist (asked before an upload overwrites them).
#[tauri::command]
pub(crate) async fn sftp_existing(
    id: String,
    paths: Vec<String>,
    state: tauri::State<'_, SftpState>,
) -> Result<Vec<String>, String> {
    let client = state.client(&id)?;
    blocking(move || {
        let mut existing = Vec::new();
        for path in paths {
            if client.exists(&path)? {
                existing.push(path);
            }
        }
        Ok(existing)
    })
    .await
}

/// Local files or folders for "Upload …", picked in a dialog opened here.
#[tauri::command]
pub(crate) async fn sftp_pick_files(
    window: tauri::WebviewWindow,
    folders: bool,
) -> Result<Vec<String>, String> {
    let dialog = window.dialog().file().set_parent(&window);
    let picked = if folders {
        dialog.blocking_pick_folders()
    } else {
        dialog.blocking_pick_files()
    }
    .unwrap_or_default();
    Ok(picked
        .into_iter()
        .filter_map(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

/// Dropped or picked local paths: absolute paths of existing files or folders.
fn upload_sources(paths: &[String]) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() || paths.len() > MAX_UPLOAD_FILES {
        return Err("Choose between 1 and 500 files".to_string());
    }
    paths
        .iter()
        .map(|path| {
            let path = PathBuf::from(path);
            if !path.is_absolute() || !(path.is_file() || path.is_dir()) {
                return Err("The local file is unavailable".to_string());
            }
            Ok(path)
        })
        .collect()
}

/// Uploads files and whole folders into `remote_dir`, one item after another, reporting each
/// on `on_progress`. Existing folders are merged, files with the same name replaced.
#[tauri::command]
pub(crate) async fn sftp_upload(
    id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    transfer_id: String,
    on_progress: Channel<TransferEvent>,
    state: tauri::State<'_, SftpState>,
) -> Result<(), String> {
    let sources = upload_sources(&local_paths)?;
    let client = state.client(&id)?;
    let cancel = state.start_transfer(&transfer_id)?;
    let result = blocking(move || {
        for source in sources {
            let name = file_name(&source.to_string_lossy());
            run_item(
                &on_progress,
                &name,
                &cancel,
                || transfer::plan_upload(&source, &remote_dir),
                |plan, report| transfer::run_upload(&client, plan, &cancel, report),
            );
            if cancel.load(Ordering::Relaxed) {
                break;
            }
        }
        Ok(())
    })
    .await;
    state.end_transfer(&transfer_id);
    result
}

/// Downloads a file (save dialog) or a whole folder (folder dialog; it is created inside the
/// chosen folder, as "name (2)" when the name is taken). Returns the local path, or None when
/// the dialog was cancelled.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn sftp_download(
    window: tauri::WebviewWindow,
    id: String,
    remote_path: String,
    is_dir: bool,
    transfer_id: String,
    on_progress: Channel<TransferEvent>,
    state: tauri::State<'_, SftpState>,
) -> Result<Option<String>, String> {
    let client = state.client(&id)?;
    let name = file_name(&remote_path);
    if !transfer::safe_name(&name) {
        return Err("This name cannot be used on this computer".to_string());
    }
    let mut dialog = window.dialog().file().set_parent(&window);
    if let Ok(downloads) = tauri::Manager::path(&window).download_dir() {
        dialog = dialog.set_directory(downloads);
    }
    let picked = if is_dir {
        dialog.blocking_pick_folder()
    } else {
        dialog.set_file_name(&name).blocking_save_file()
    };
    let Some(picked) = picked else {
        return Ok(None);
    };
    let picked = picked
        .into_path()
        .map_err(|_| "This location cannot be used".to_string())?;
    // A file goes exactly where the save dialog says; a folder goes inside the chosen folder.
    let (local_dir, local_name) = if is_dir {
        let local_name = transfer::free_local_name(&picked, &name);
        (picked, local_name)
    } else {
        let local_name = picked
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .ok_or_else(|| "This location cannot be used".to_string())?;
        let local_dir = picked
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "This location cannot be used".to_string())?;
        (local_dir, local_name)
    };
    let shown = local_dir.join(&local_name).to_string_lossy().into_owned();
    let cancel = state.start_transfer(&transfer_id)?;
    let result = blocking(move || {
        run_item(
            &on_progress,
            &name,
            &cancel,
            || transfer::plan_download(&client, &remote_path, is_dir, &local_dir, &local_name),
            |plan, report| transfer::run_download(&client, plan, &cancel, report),
        );
        Ok(())
    })
    .await;
    state.end_transfer(&transfer_id);
    result.map(|()| Some(shown))
}

#[tauri::command]
pub(crate) fn sftp_cancel(transfer_id: String, state: tauri::State<'_, SftpState>) {
    if let Ok(transfers) = state.transfers.lock() {
        if let Some(cancel) = transfers.get(&transfer_id) {
            cancel.store(true, Ordering::Relaxed);
        }
    }
}

/// Plans and copies one item, reporting start, progress (at most 10 times a second) and the
/// result. Files that failed inside a folder are counted; the item then ends as "failed".
fn run_item<Plan>(
    channel: &Channel<TransferEvent>,
    name: &str,
    cancel: &AtomicBool,
    plan: impl FnOnce() -> Result<Plan, String>,
    copy: impl FnOnce(&Plan, &mut dyn FnMut(u64, &str)) -> Result<transfer::Outcome, String>,
) -> bool
where
    Plan: PlanTotal,
{
    let event = |current: &str, bytes, total, state, failed, error| TransferEvent {
        file: name.to_string(),
        current: current.to_string(),
        bytes,
        total,
        state,
        failed,
        error,
    };
    let _ = channel.send(event(name, 0, 0, "running", 0, None));
    let plan = match plan() {
        Ok(plan) => plan,
        Err(error) => {
            let _ = channel.send(event(name, 0, 0, "failed", 0, Some(error)));
            return false;
        }
    };
    let total = plan.total();
    let mut throttle = Throttle::new(Duration::from_millis(100));
    let (mut last, mut current) = (0, name.to_string());
    let result = copy(&plan, &mut |bytes, file| {
        last = bytes;
        if file != current {
            current = file.to_string();
        }
        if throttle.ready() {
            let _ = channel.send(event(file, bytes, total, "running", 0, None));
        }
    });
    let complete = matches!(&result, Ok(outcome) if outcome.failed == 0);
    let _ = channel.send(match result {
        Ok(outcome) if outcome.failed == 0 => event(name, total.max(last), total, "done", 0, None),
        Ok(outcome) => event(
            name,
            last,
            total,
            "failed",
            outcome.failed,
            outcome.first_error,
        ),
        Err(_) if cancel.load(Ordering::Relaxed) => {
            event(&current, last, total, "cancelled", 0, None)
        }
        Err(error) if error == CANCELLED => event(&current, last, total, "cancelled", 0, None),
        Err(error) => event(&current, last, total, "failed", 0, Some(error)),
    });
    complete
}

/// Total size of a plan, whatever its path types.
trait PlanTotal {
    fn total(&self) -> u64;
}

impl<Dir, File> PlanTotal for transfer::Plan<Dir, File> {
    fn total(&self) -> u64 {
        self.total
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn upload_sources_are_existing_absolute_files() {
        let dir = std::env::temp_dir().join(format!("crabshell-upload-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let text = |path: &Path| path.to_string_lossy().into_owned();

        assert_eq!(
            upload_sources(&[text(&file)]).unwrap(),
            std::slice::from_ref(&file)
        );
        assert!(upload_sources(&[]).is_err());
        assert!(upload_sources(&["a.txt".into()]).is_err());
        assert_eq!(
            upload_sources(&[text(&dir)]).unwrap(),
            std::slice::from_ref(&dir)
        );
        assert!(upload_sources(&[text(&dir.join("missing"))]).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn move_targets_refuse_loops_and_staying_put() {
        assert_eq!(
            move_target("/srv/a.txt", "/home/u").unwrap(),
            "/home/u/a.txt"
        );
        assert_eq!(move_target("/srv/site", "/").unwrap(), "/site");
        assert!(move_target("/srv/site", "/srv/site").is_err());
        assert!(move_target("/srv/site", "/srv/site/css").is_err());
        assert!(move_target("/srv/a.txt", "/srv").is_err());
        assert!(move_target("/srv/site", "/srv/site-old").is_ok());
    }

    #[test]
    fn builds_a_batch_mode_sftp_command() {
        let request = SftpConnectRequest {
            host: "web".into(),
            port: Some(2222),
            username: Some("deploy".into()),
            identity_file: None,
            proxy: None,
            keepalive_seconds: None,
        };
        let command = sftp_command(&request).unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(&args[..3], ["-o", "BatchMode=yes", "-s"]);
        assert!(args.windows(2).any(|pair| pair == ["-p", "2222"]));
        assert!(args.windows(2).any(|pair| pair == ["-l", "deploy"]));
        assert_eq!(&args[args.len() - 3..], ["--", "web", "sftp"]);

        let bad = SftpConnectRequest {
            host: "-oProxyCommand=x".into(),
            ..request
        };
        assert!(sftp_command(&bad).is_err());
        assert_eq!(file_name("/srv/www/app.js"), "app.js");
        assert_eq!(file_name(r"C:\Users\a\b.txt"), "b.txt");
    }
}

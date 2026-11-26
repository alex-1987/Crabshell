//! Running terminal sessions (local shells and OpenSSH) and the commands that drive them.
//! The PTY handling itself lives in `session.rs`.

use std::{
    collections::HashMap,
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::InvokeResponseBody, Manager};

use crate::session::{validate_session_id, PtySession, SessionReader, TerminalSession};

type SharedSession = Arc<dyn TerminalSession>;

#[derive(Default)]
pub(crate) struct AppState {
    sessions: Mutex<HashMap<String, SessionEntry>>,
}

struct SessionEntry {
    session: SharedSession,
    on_state: tauri::ipc::Channel<SessionEvent>,
    /// Set once the session is being closed, so the reader thread does not report it again.
    stopping: Arc<AtomicBool>,
}

impl SessionEntry {
    /// Ends the process and reports the result to the frontend.
    fn shut_down(&self, message: &str) -> Result<(), String> {
        self.stopping.store(true, Ordering::Release);
        let result = self.session.close();
        let event = match &result {
            Ok(()) => SessionEvent::Disconnected {
                message: message.to_string(),
                exit_code: None,
            },
            Err(error) => SessionEvent::Failed {
                message: error.clone(),
            },
        };
        let _ = self.on_state.send(event);
        result
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectRequest {
    session_id: String,
    host: String,
    port: Option<u16>,
    username: Option<String>,
    identity_file: Option<String>,
    /// Only set when the server uses the proxy and the proxy is switched on and filled in.
    #[serde(default)]
    proxy: Option<crate::proxy::ProxyConfig>,
    /// Seconds between SSH keepalives; None when switched off.
    #[serde(default)]
    keepalive_seconds: Option<u16>,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalShellRequest {
    session_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum SessionEvent {
    Connecting,
    Connected,
    Disconnected {
        message: String,
        /// Exit code when the process ended on its own (OpenSSH: 255 = connection lost or
        /// failed); None when Crabshell closed it.
        #[serde(rename = "exitCode")]
        exit_code: Option<u32>,
    },
    Failed {
        message: String,
    },
}

const MANAGER_UNAVAILABLE: &str = "The session manager is unavailable";
const ALREADY_OPEN: &str = "This session is already open";
/// Upper limit per `write_to_session` call; the frontend sends chunks of half this size.
const MAX_WRITE_BYTES: usize = 64 * 1024;

impl AppState {
    fn sessions(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, SessionEntry>>, String> {
        self.sessions
            .lock()
            .map_err(|_| MANAGER_UNAVAILABLE.to_string())
    }

    /// The session's handle, cloned so the map lock is released before it is used.
    fn session(&self, session_id: &str) -> Result<SharedSession, String> {
        validate_session_id(session_id)?;
        self.sessions()?
            .get(session_id)
            .map(|entry| Arc::clone(&entry.session))
            .ok_or_else(|| "The session is not open".to_string())
    }

    pub(crate) fn close_all(&self) {
        let Ok(sessions) = self
            .sessions()
            .map(|mut sessions| std::mem::take(&mut *sessions))
        else {
            return;
        };
        for entry in sessions.into_values() {
            let _ = entry.shut_down("Application closed");
        }
    }
}

/// Async: reading the host's config (`ssh -G`) runs a process, which must not block the window.
#[tauri::command]
pub(crate) async fn connect_host(
    request: ConnectRequest,
    on_data: tauri::ipc::Channel<InvokeResponseBody>,
    on_state: tauri::ipc::Channel<SessionEvent>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let (proxy, keepalive, host, port, username) = (
        request.proxy.clone(),
        request.keepalive_seconds,
        request.host.clone(),
        request.port,
        request.username.clone(),
    );
    let options = tauri::async_runtime::spawn_blocking(move || {
        crate::conntest::ssh_options(proxy.as_ref(), keepalive, &host, port, username.as_deref())
    })
    .await
    .map_err(|_| MANAGER_UNAVAILABLE.to_string())??;
    start_session(
        request.session_id,
        || {
            PtySession::connect_ssh(
                &request.host,
                request.port,
                request.username.as_deref(),
                request.identity_file.as_deref(),
                &options,
                request.cols,
                request.rows,
            )
        },
        on_data,
        on_state,
        app,
        state,
    )
}

#[tauri::command]
pub(crate) fn open_local_shell(
    request: LocalShellRequest,
    on_data: tauri::ipc::Channel<InvokeResponseBody>,
    on_state: tauri::ipc::Channel<SessionEvent>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    start_session(
        request.session_id,
        || PtySession::open_local_shell(request.cols, request.rows),
        on_data,
        on_state,
        app,
        state,
    )
}

/// Registers a freshly spawned terminal process and streams its output until it ends.
fn start_session(
    session_id: String,
    spawn: impl FnOnce() -> Result<(PtySession, SessionReader), String>,
    on_data: tauri::ipc::Channel<InvokeResponseBody>,
    on_state: tauri::ipc::Channel<SessionEvent>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    on_state
        .send(SessionEvent::Connecting)
        .map_err(|_| "The terminal view is unavailable".to_string())?;

    // Checked before spawning, so a duplicate id never starts a process.
    if state.sessions()?.contains_key(&session_id) {
        return Err(ALREADY_OPEN.to_string());
    }

    let (session, mut reader) = match spawn() {
        Ok(result) => result,
        Err(message) => {
            let _ = on_state.send(SessionEvent::Failed {
                message: message.clone(),
            });
            return Err(message);
        }
    };

    let session: SharedSession = Arc::new(session);
    let stopping = Arc::new(AtomicBool::new(false));
    {
        let mut sessions = match state.sessions() {
            Ok(sessions) => sessions,
            Err(message) => {
                let _ = session.close();
                return Err(message);
            }
        };
        if sessions.contains_key(&session_id) {
            drop(sessions);
            let _ = session.close();
            return Err(ALREADY_OPEN.to_string());
        }
        sessions.insert(
            session_id.clone(),
            SessionEntry {
                session: Arc::clone(&session),
                on_state: on_state.clone(),
                stopping: Arc::clone(&stopping),
            },
        );
    }

    let _ = on_state.send(SessionEvent::Connected);

    let app_handle = app.clone();
    let worker_session_id = session_id.clone();
    let worker_session = Arc::clone(&session);
    let worker_stopping = Arc::clone(&stopping);
    let worker_state = on_state.clone();

    let spawned = thread::Builder::new()
        .name("crabshell-pty-reader".to_string())
        .spawn(move || {
            let mut buffer = [0_u8; 8192];
            let message = loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break "The session ended",
                    Ok(count) => {
                        if on_data
                            .send(InvokeResponseBody::Raw(buffer[..count].to_vec()))
                            .is_err()
                        {
                            break "The terminal view is no longer available";
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => break "The terminal stream ended",
                }
            };
            finish_session(
                &app_handle,
                &worker_session_id,
                &worker_session,
                &worker_stopping,
                &worker_state,
                message,
            );
        });

    if spawned.is_err() {
        let entry = state
            .sessions()
            .ok()
            .and_then(|mut sessions| sessions.remove(&session_id));
        let message = "Could not start the terminal reader";
        stopping.store(true, Ordering::Release);
        let _ = session.close();
        if entry.is_some() {
            let _ = on_state.send(SessionEvent::Failed {
                message: message.to_string(),
            });
        }
        return Err(message.to_string());
    }

    Ok(())
}

/// The process ended on its own (or its output could not be delivered): report it, then clean up.
fn finish_session(
    app_handle: &tauri::AppHandle,
    session_id: &str,
    session: &SharedSession,
    stopping: &Arc<AtomicBool>,
    on_state: &tauri::ipc::Channel<SessionEvent>,
    message: &str,
) {
    if stopping.swap(true, Ordering::AcqRel) {
        return;
    }

    let _ = on_state.send(SessionEvent::Disconnected {
        message: message.to_string(),
        exit_code: session.exit_code(),
    });
    if let Ok(mut sessions) = app_handle.state::<AppState>().sessions() {
        // Only this run's entry; the id may already belong to a new session.
        let is_current = sessions
            .get(session_id)
            .is_some_and(|entry| Arc::ptr_eq(&entry.stopping, stopping));
        if is_current {
            sessions.remove(session_id);
        }
    }
    let _ = session.close();
}

/// Async with a blocking task: a write to a program that stops reading (e.g. a stalled SSH
/// connection) blocks, and sync commands run on the main thread, which would freeze the window.
#[tauri::command]
pub(crate) async fn write_to_session(
    request: tauri::ipc::Request<'_>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let session_id = request
        .headers()
        .get("x-session-id")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "Missing session identifier".to_string())?;
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("Terminal input must be sent as raw bytes".to_string());
    };
    if data.len() > MAX_WRITE_BYTES {
        return Err("Terminal input is too large".to_string());
    }

    let session = state.session(session_id)?;
    let data = data.clone();
    tauri::async_runtime::spawn_blocking(move || session.write(&data))
        .await
        .map_err(|_| "Could not write to the terminal".to_string())?
}

#[tauri::command]
pub(crate) fn resize_session(
    session_id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.session(&session_id)?.resize(cols, rows)
}

#[tauri::command]
pub(crate) fn close_session(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let entry = state.sessions()?.remove(&session_id);
    entry.map_or(Ok(()), |entry| entry.shut_down("Session closed"))
}

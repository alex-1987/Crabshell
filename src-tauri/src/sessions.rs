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

#[derive(Default)]
pub(crate) struct AppState {
    sessions: Mutex<HashMap<String, SessionEntry>>,
}

struct SessionEntry {
    session: Arc<Mutex<Box<dyn TerminalSession>>>,
    on_state: tauri::ipc::Channel<SessionEvent>,
    stopping: Arc<AtomicBool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectRequest {
    session_id: String,
    host: String,
    port: Option<u16>,
    username: Option<String>,
    identity_file: Option<String>,
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
    Disconnected { message: String },
    Failed { message: String },
}

impl AppState {
    pub(crate) fn close_all(&self) {
        let sessions = match self.sessions.lock() {
            Ok(mut sessions) => std::mem::take(&mut *sessions),
            Err(_) => return,
        };

        for (_, entry) in sessions {
            entry.stopping.store(true, Ordering::Release);
            let close_result = close_entry_session(&entry);
            let event = match close_result {
                Ok(()) => SessionEvent::Disconnected {
                    message: "Application closed".to_string(),
                },
                Err(message) => SessionEvent::Failed { message },
            };
            let _ = entry.on_state.send(event);
        }
    }
}

fn close_entry_session(entry: &SessionEntry) -> Result<(), String> {
    let mut session = entry
        .session
        .lock()
        .map_err(|_| "The session is unavailable".to_string())?;
    session.close()
}

#[tauri::command]
pub(crate) fn connect_host(
    request: ConnectRequest,
    on_data: tauri::ipc::Channel<InvokeResponseBody>,
    on_state: tauri::ipc::Channel<SessionEvent>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    start_session(
        request.session_id,
        || {
            PtySession::connect_ssh(
                &request.host,
                request.port,
                request.username.as_deref(),
                request.identity_file.as_deref(),
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

    {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "The session manager is unavailable".to_string())?;
        if sessions.contains_key(&session_id) {
            return Err("This session is already open".to_string());
        }
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

    let session: Arc<Mutex<Box<dyn TerminalSession>>> = Arc::new(Mutex::new(Box::new(session)));
    let stopping = Arc::new(AtomicBool::new(false));
    let entry = SessionEntry {
        session: Arc::clone(&session),
        on_state: on_state.clone(),
        stopping: Arc::clone(&stopping),
    };

    let inserted = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "The session manager is unavailable".to_string())?;
        if sessions.contains_key(&session_id) {
            false
        } else {
            sessions.insert(session_id.clone(), entry);
            true
        }
    };
    if !inserted {
        let _ = close_entry_session(&SessionEntry {
            session: Arc::clone(&session),
            on_state: on_state.clone(),
            stopping: Arc::clone(&stopping),
        });
        return Err("This session is already open".to_string());
    }

    let _ = on_state.send(SessionEvent::Connected);

    let app_handle = app.clone();
    let worker_session_id = session_id.clone();
    let worker_session = Arc::clone(&session);
    let worker_stopping = Arc::clone(&stopping);
    let worker_state = on_state.clone();

    if thread::Builder::new()
        .name("crabshell-pty-reader".to_string())
        .spawn(move || {
            let mut buffer = [0_u8; 8192];
            let message = loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break "The session ended".to_string(),
                    Ok(count) => {
                        if on_data
                            .send(InvokeResponseBody::Raw(buffer[..count].to_vec()))
                            .is_err()
                        {
                            break "The terminal view is no longer available".to_string();
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break "The terminal stream ended".to_string(),
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
        })
        .is_err()
    {
        stopping.store(true, Ordering::Release);
        if let Ok(mut sessions) = state.sessions.lock() {
            sessions.remove(&session_id);
        }
        let message = "Could not start the terminal reader".to_string();
        let _ = close_entry_session(&SessionEntry {
            session,
            on_state: on_state.clone(),
            stopping,
        });
        let _ = on_state.send(SessionEvent::Failed {
            message: message.clone(),
        });
        return Err(message);
    }

    Ok(())
}

fn finish_session(
    app_handle: &tauri::AppHandle,
    session_id: &str,
    session: &Arc<Mutex<Box<dyn TerminalSession>>>,
    stopping: &AtomicBool,
    on_state: &tauri::ipc::Channel<SessionEvent>,
    message: String,
) {
    if stopping.swap(true, Ordering::AcqRel) {
        return;
    }

    let _ = on_state.send(SessionEvent::Disconnected { message });
    if let Ok(mut sessions) = app_handle.state::<AppState>().sessions.lock() {
        let is_current = sessions
            .get(session_id)
            .is_some_and(|entry| Arc::ptr_eq(&entry.session, session));
        if is_current {
            sessions.remove(session_id);
        }
    }

    if let Ok(mut session) = session.lock() {
        let _ = session.close();
    }
}

#[tauri::command]
pub(crate) fn write_to_session(
    request: tauri::ipc::Request<'_>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let session_id = request
        .headers()
        .get("x-session-id")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "Missing session identifier".to_string())?;
    validate_session_id(session_id)?;

    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data,
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("Terminal input must be sent as raw bytes".to_string());
        }
    };
    if data.len() > 65_536 {
        return Err("Terminal input is too large".to_string());
    }

    let session = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "The session manager is unavailable".to_string())?;
        sessions
            .get(session_id)
            .map(|entry| Arc::clone(&entry.session))
            .ok_or_else(|| "The session is not open".to_string())?
    };

    let mut session = session
        .lock()
        .map_err(|_| "The session is unavailable".to_string())?;
    session.write(data)
}

#[tauri::command]
pub(crate) fn resize_session(
    session_id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let session = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "The session manager is unavailable".to_string())?;
        sessions
            .get(&session_id)
            .map(|entry| Arc::clone(&entry.session))
            .ok_or_else(|| "The session is not open".to_string())?
    };

    let session = session
        .lock()
        .map_err(|_| "The session is unavailable".to_string())?;
    session.resize(cols, rows)
}

#[tauri::command]
pub(crate) fn close_session(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let entry = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "The session manager is unavailable".to_string())?;
        sessions.remove(&session_id)
    };

    if let Some(entry) = entry {
        entry.stopping.store(true, Ordering::Release);
        let close_result = close_entry_session(&entry);
        let event = match &close_result {
            Ok(()) => SessionEvent::Disconnected {
                message: "Session closed".to_string(),
            },
            Err(message) => SessionEvent::Failed {
                message: message.clone(),
            },
        };
        let _ = entry.on_state.send(event);
        close_result
    } else {
        Ok(())
    }
}

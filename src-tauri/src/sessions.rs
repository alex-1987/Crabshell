//! Running terminal sessions (local shells and OpenSSH) and the commands that drive them.
//! The PTY handling itself lives in `session.rs`.

use std::{
    collections::HashMap,
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
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

    // Two threads: one only reads the PTY, the other sends to the terminal view. While a send is
    // under way, further output queues up and goes out as one message: ConPTY (Windows) delivers
    // many small pieces, and one IPC message per piece made fast output slow. Nothing waits on
    // purpose, so a typed character is still echoed at once.
    let spawned = thread::Builder::new()
        .name("crabshell-pty-output".to_string())
        .spawn(move || {
            let (sender, receiver) = mpsc::channel();
            let read_thread = thread::Builder::new()
                .name("crabshell-pty-reader".to_string())
                .spawn(move || read_output(&mut reader, &sender));
            let message = if read_thread.is_err() {
                "Could not start the terminal reader"
            } else {
                send_output(&receiver, |batch| {
                    on_data.send(InvokeResponseBody::Raw(batch)).is_ok()
                })
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

/// Output of the PTY, or why it ended.
enum Output {
    Data(Vec<u8>),
    End(&'static str),
}

const READ_BUFFER_BYTES: usize = 64 * 1024;
/// A batch stops growing once it holds this much (it may exceed it by one read).
const MAX_BATCH_BYTES: usize = 256 * 1024;

/// Reads the PTY until it ends; stops early when nobody receives any more.
fn read_output(reader: &mut SessionReader, sender: &mpsc::Sender<Output>) {
    let mut buffer = vec![0_u8; READ_BUFFER_BYTES];
    loop {
        let output = match reader.read(&mut buffer) {
            Ok(0) => Output::End("The session ended"),
            Ok(count) => Output::Data(buffer[..count].to_vec()),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => Output::End("The terminal stream ended"),
        };
        let ended = matches!(output, Output::End(_));
        if sender.send(output).is_err() || ended {
            return;
        }
    }
}

/// Sends the output in batches until it ends or `send` fails; returns why it stopped.
fn send_output(
    receiver: &mpsc::Receiver<Output>,
    mut send: impl FnMut(Vec<u8>) -> bool,
) -> &'static str {
    loop {
        let mut batch = match receiver.recv() {
            Ok(Output::Data(data)) => data,
            Ok(Output::End(message)) => return message,
            Err(_) => return "The terminal stream ended",
        };
        let ended = drain_into(receiver, &mut batch, MAX_BATCH_BYTES);
        if !send(batch) {
            return "The terminal view is no longer available";
        }
        if let Some(message) = ended {
            return message;
        }
    }
}

/// Appends the output that is already waiting, without waiting for more, until the batch holds
/// `limit` bytes. Returns the end message when the end was among it.
fn drain_into(
    receiver: &mpsc::Receiver<Output>,
    batch: &mut Vec<u8>,
    limit: usize,
) -> Option<&'static str> {
    while batch.len() < limit {
        match receiver.try_recv() {
            Ok(Output::Data(data)) => batch.extend_from_slice(&data),
            Ok(Output::End(message)) => return Some(message),
            Err(mpsc::TryRecvError::Empty) => return None,
            Err(mpsc::TryRecvError::Disconnected) => return Some("The terminal stream ended"),
        }
    }
    None
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

#[cfg(test)]
mod tests {
    use super::{drain_into, read_output, send_output, Output, SessionReader};
    use std::sync::mpsc;

    fn data(bytes: &[u8]) -> Output {
        Output::Data(bytes.to_vec())
    }

    #[test]
    fn waiting_output_goes_out_as_one_batch() {
        let (sender, receiver) = mpsc::channel();
        for piece in [b"ab".as_slice(), b"cd", b"ef"] {
            sender.send(data(piece)).unwrap();
        }
        sender.send(Output::End("The session ended")).unwrap();
        let mut sent = Vec::new();
        let message = send_output(&receiver, |batch| {
            sent.push(batch);
            true
        });
        assert_eq!(sent, vec![b"abcdef".to_vec()]);
        assert_eq!(message, "The session ended");
    }

    #[test]
    fn batches_stop_growing_at_the_limit() {
        let (sender, receiver) = mpsc::channel();
        for _ in 0..4 {
            sender.send(data(&[1; 10])).unwrap();
        }
        let mut batch = vec![0; 10];
        assert_eq!(drain_into(&receiver, &mut batch, 25), None);
        assert_eq!(batch.len(), 30);
        // The rest stays queued for the next batch.
        assert_eq!(receiver.try_iter().count(), 2);
    }

    #[test]
    fn does_not_wait_for_more_output() {
        let (sender, receiver) = mpsc::channel::<Output>();
        let mut batch = b"x".to_vec();
        assert_eq!(drain_into(&receiver, &mut batch, 1024), None);
        assert_eq!(batch, b"x");
        drop(sender);
        assert_eq!(
            drain_into(&receiver, &mut batch, 1024),
            Some("The terminal stream ended")
        );
    }

    #[test]
    fn a_closed_view_stops_sending() {
        let (sender, receiver) = mpsc::channel();
        sender.send(data(b"a")).unwrap();
        sender.send(data(b"b")).unwrap();
        let message = send_output(&receiver, |_| false);
        assert_eq!(message, "The terminal view is no longer available");
    }

    #[test]
    fn reads_everything_then_reports_the_end() {
        let mut reader: SessionReader = Box::new(std::io::Cursor::new(b"hello".to_vec()));
        let (sender, receiver) = mpsc::channel();
        read_output(&mut reader, &sender);
        let mut sent = Vec::new();
        let message = send_output(&receiver, |batch| {
            sent.extend(batch);
            true
        });
        assert_eq!(sent, b"hello");
        assert_eq!(message, "The session ended");
    }
}

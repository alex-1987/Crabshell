//! An SFTP connection over a child process: `ssh … -s -- host sftp` in the app, the local
//! `sftp-server` in tests. A reader thread hands each reply to the request with its id, so a
//! directory listing can run while a transfer is going on.

use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc::{channel, Receiver, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use super::protocol::{self, Attrs, FileEntry, Response};

/// Bytes per read or write request (OpenSSH's sftp uses the same).
const CHUNK: usize = 32 * 1024;
/// Requests in flight during a transfer; hides the round trip time.
const WINDOW: usize = 16;
/// A server that does not answer one request in this time is treated as gone.
const REPLY_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_STDERR: usize = 16 * 1024;

pub(crate) const CANCELLED: &str = "The transfer was cancelled";
const LOST: &str = "The file connection was lost";

type Pending = Arc<Mutex<HashMap<u32, Sender<Response>>>>;
/// Gets each piece of a remote file with its offset.
type Sink<'a> = dyn FnMut(u64, &[u8]) -> Result<(), String> + 'a;

pub(crate) struct SftpClient {
    writer: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Pending,
    next_id: AtomicU32,
    alive: Arc<AtomicBool>,
}

fn read_packet(reader: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    reader.read_exact(&mut len)?;
    let len = u32::from_be_bytes(len) as usize;
    if len == 0 || len > protocol::MAX_PACKET {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    Ok(body)
}

/// OpenSSH's message on stderr as a message the user can act on.
pub(crate) fn ssh_error(stderr: &str) -> String {
    let has = |text: &str| stderr.contains(text);
    if has("Host key verification failed") || has("No ED25519 host key is known") {
        "Unknown host key: connect to this server once in the terminal to confirm it".to_string()
    } else if has("Permission denied") || has("Too many authentication failures") {
        "The file browser needs a login with a key or ssh-agent (no password)".to_string()
    } else if has("Could not resolve hostname") {
        "Host not found".to_string()
    } else if has("subsystem request failed") {
        "The server does not offer SFTP".to_string()
    } else if has("Connection refused") || has("timed out") || has("No route to host") {
        "The server cannot be reached".to_string()
    } else {
        stderr
            .lines()
            .map(str::trim)
            .rfind(|line| !line.is_empty())
            .map(|line| line.chars().take(200).collect())
            .unwrap_or_else(|| "The file connection failed".to_string())
    }
}

impl SftpClient {
    /// Starts the process and does the version handshake.
    pub(crate) fn start(mut command: Command, missing: &str) -> Result<Self, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|_| missing.to_string())?;
        let (Some(mut stdin), Some(mut stdout), Some(mut stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("The file connection failed".to_string());
        };

        // Collected so a failed login can be explained.
        let errors = Arc::new(Mutex::new(String::new()));
        let collected = Arc::clone(&errors);
        thread::spawn(move || {
            let mut buffer = [0u8; 1024];
            while let Ok(read) = stderr.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                if let Ok(mut text) = collected.lock() {
                    if text.len() < MAX_STDERR {
                        text.push_str(&String::from_utf8_lossy(&buffer[..read]));
                    }
                }
            }
        });

        let handshake = stdin
            .write_all(&protocol::init())
            .and_then(|()| stdin.flush())
            .and_then(|()| read_packet(&mut stdout))
            .map_err(|_| ())
            .and_then(|body| protocol::parse_version(&body).map_err(|_| ()));
        if handshake.is_err() {
            let _ = child.kill();
            let _ = child.wait();
            // Give the stderr thread a moment to collect the last lines.
            thread::sleep(Duration::from_millis(100));
            let text = errors.lock().map(|text| text.clone()).unwrap_or_default();
            return Err(ssh_error(&text));
        }

        let pending: Pending = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        spawn_reader(stdout, Arc::clone(&pending), Arc::clone(&alive));
        Ok(Self {
            writer: Mutex::new(stdin),
            child: Mutex::new(child),
            pending,
            next_id: AtomicU32::new(1),
            alive,
        })
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    /// Sends a request; the reply arrives on the returned receiver.
    fn send(&self, build: impl FnOnce(u32) -> Vec<u8>) -> Result<Receiver<Response>, String> {
        if !self.is_alive() {
            return Err(LOST.to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = channel();
        self.pending
            .lock()
            .map_err(|_| LOST.to_string())?
            .insert(id, sender);
        let packet = build(id);
        let written = self.writer.lock().map_err(|_| ()).and_then(|mut writer| {
            writer
                .write_all(&packet)
                .and_then(|()| writer.flush())
                .map_err(|_| ())
        });
        if written.is_err() {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(LOST.to_string());
        }
        Ok(receiver)
    }

    fn wait(&self, receiver: Receiver<Response>) -> Result<Response, String> {
        receiver
            .recv_timeout(REPLY_TIMEOUT)
            .map_err(|error| match error {
                RecvTimeoutError::Timeout => "The server does not answer".to_string(),
                RecvTimeoutError::Disconnected => LOST.to_string(),
            })
    }

    fn request(&self, build: impl FnOnce(u32) -> Vec<u8>) -> Result<Response, String> {
        let receiver = self.send(build)?;
        self.wait(receiver)
    }

    /// Absolute form of a path ("." is the home directory).
    pub(crate) fn realpath(&self, path: &str) -> Result<String, String> {
        match self.request(|id| protocol::realpath(id, path))? {
            Response::Name(names) => names
                .into_iter()
                .next()
                .map(|(name, _)| name)
                .ok_or_else(|| "The server sent an unexpected answer".to_string()),
            other => Err(other.error()),
        }
    }

    pub(crate) fn stat(&self, path: &str) -> Result<Attrs, String> {
        self.request(|id| protocol::stat(id, path))?.attrs()
    }

    /// Whether anything (also a broken link) exists at the path.
    pub(crate) fn exists(&self, path: &str) -> Result<bool, String> {
        match self.request(|id| protocol::lstat(id, path))? {
            Response::Attrs(_) => Ok(true),
            Response::Status { code: 2, .. } => Ok(false),
            other => Err(other.error()),
        }
    }

    /// Entries of a directory without "." and "..". Links to directories count as directories.
    pub(crate) fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, String> {
        let handle = self.request(|id| protocol::opendir(id, path))?.handle()?;
        let mut entries = Vec::new();
        let listed = loop {
            match self.request(|id| protocol::readdir(id, &handle)) {
                Ok(Response::Name(names)) => {
                    entries.extend(
                        names
                            .into_iter()
                            .filter(|(name, _)| name != "." && name != "..")
                            .map(|(name, attrs)| FileEntry::new(name, &attrs)),
                    );
                }
                Ok(Response::Status {
                    code: protocol::STATUS_EOF,
                    ..
                }) => break Ok(()),
                Ok(other) => break Err(other.error()),
                Err(error) => break Err(error),
            }
        };
        let _ = self.request(|id| protocol::close(id, &handle));
        listed?;
        let base = path.trim_end_matches('/');
        for entry in entries.iter_mut().filter(|entry| entry.is_link) {
            // A broken link stays a plain link.
            if let Ok(target) = self.stat(&format!("{base}/{}", entry.name)) {
                entry.is_dir = target.is_dir();
            }
        }
        Ok(entries)
    }

    pub(crate) fn mkdir(&self, path: &str) -> Result<(), String> {
        self.request(|id| protocol::mkdir(id, path))?.ok()
    }

    pub(crate) fn rmdir(&self, path: &str) -> Result<(), String> {
        self.request(|id| protocol::rmdir(id, path))?.ok()
    }

    pub(crate) fn remove(&self, path: &str) -> Result<(), String> {
        self.request(|id| protocol::remove(id, path))?.ok()
    }

    pub(crate) fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        self.request(|id| protocol::rename(id, from, to))?.ok()
    }

    /// Copies a local file to `remote` (created or replaced). A cancelled or failed upload
    /// removes the partial remote file. `progress` gets the bytes the server confirmed.
    pub(crate) fn upload(
        &self,
        local: &Path,
        remote: &str,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> Result<(), String> {
        let mut file =
            File::open(local).map_err(|_| "Could not read the local file".to_string())?;
        let flags = protocol::OPEN_WRITE | protocol::OPEN_CREATE | protocol::OPEN_TRUNCATE;
        let handle = self
            .request(|id| protocol::open(id, remote, flags))?
            .handle()?;
        let result = (|| {
            let mut buffer = vec![0u8; CHUNK];
            let mut in_flight = VecDeque::new();
            let (mut offset, mut confirmed) = (0u64, 0u64);
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err(CANCELLED.to_string());
                }
                let read = read_full(&mut file, &mut buffer)
                    .map_err(|_| "Could not read the local file".to_string())?;
                if read == 0 {
                    break;
                }
                let receiver =
                    self.send(|id| protocol::write(id, &handle, offset, &buffer[..read]))?;
                in_flight.push_back((receiver, read as u64));
                offset += read as u64;
                if in_flight.len() >= WINDOW {
                    if let Some((receiver, len)) = in_flight.pop_front() {
                        self.wait(receiver)?.ok()?;
                        confirmed += len;
                        progress(confirmed);
                    }
                }
            }
            while let Some((receiver, len)) = in_flight.pop_front() {
                self.wait(receiver)?.ok()?;
                confirmed += len;
                progress(confirmed);
            }
            Ok(())
        })();
        let closed = self
            .request(|id| protocol::close(id, &handle))
            .and_then(Response::ok);
        match result.and(closed) {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = self.remove(remote);
                Err(error)
            }
        }
    }

    /// Copies `remote` into a new local file. A cancelled or failed download removes the
    /// partial local file. `progress` gets the bytes written so far.
    pub(crate) fn download(
        &self,
        remote: &str,
        local: &Path,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> Result<(), String> {
        let size = self.stat(remote)?.size;
        let handle = self
            .request(|id| protocol::open(id, remote, protocol::OPEN_READ))?
            .handle()?;
        let result = File::create(local)
            .map_err(|_| "Could not write the file".to_string())
            .and_then(|mut file| {
                let write_error = |_| "Could not write the file".to_string();
                let mut written = 0u64;
                self.read_into(&handle, size, cancel, &mut |offset, data| {
                    file.seek(SeekFrom::Start(offset)).map_err(write_error)?;
                    file.write_all(data).map_err(write_error)?;
                    written += data.len() as u64;
                    progress(written);
                    Ok(())
                })
            });
        let _ = self.request(|id| protocol::close(id, &handle));
        if result.is_err() {
            let _ = std::fs::remove_file(local);
        }
        result
    }

    /// Reads an open remote file and hands each piece to `sink` with its offset (pieces can
    /// arrive out of order when the server sends short reads).
    fn read_into(
        &self,
        handle: &[u8],
        size: Option<u64>,
        cancel: &AtomicBool,
        sink: &mut Sink,
    ) -> Result<(), String> {
        let mut in_flight: VecDeque<(Receiver<Response>, u64, u32)> = VecDeque::new();
        // Ranges a short read left open; asked for again before new ones.
        let mut retry: VecDeque<(u64, u32)> = VecDeque::new();
        let (mut next, mut eof) = (0u64, false);
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(CANCELLED.to_string());
            }
            while in_flight.len() < WINDOW {
                let range = if let Some(range) = retry.pop_front() {
                    range
                } else if !eof && size.is_none_or(|size| next < size) {
                    let len = size.map_or(CHUNK as u64, |size| (size - next).min(CHUNK as u64));
                    let range = (next, len as u32);
                    next += len;
                    range
                } else {
                    break;
                };
                let receiver = self.send(|id| protocol::read(id, handle, range.0, range.1))?;
                in_flight.push_back((receiver, range.0, range.1));
            }
            let Some((receiver, offset, len)) = in_flight.pop_front() else {
                return Ok(());
            };
            match self.wait(receiver)? {
                Response::Data(data) if !data.is_empty() => {
                    sink(offset, &data)?;
                    let got = data.len() as u32;
                    if got < len {
                        retry.push_back((offset + u64::from(got), len - got));
                    }
                }
                Response::Data(_)
                | Response::Status {
                    code: protocol::STATUS_EOF,
                    ..
                } => eof = true,
                other => return Err(other.error()),
            }
        }
    }

    /// Copies `remote` to `dest_path` on `dest` (another server, or this one), created or
    /// replaced, without a local file in between. A cancelled or failed copy removes the partial
    /// target. `progress` gets the bytes the target server confirmed.
    pub(crate) fn copy_to(
        &self,
        remote: &str,
        dest: &SftpClient,
        dest_path: &str,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> Result<(), String> {
        let size = self.stat(remote)?.size;
        let source = self
            .request(|id| protocol::open(id, remote, protocol::OPEN_READ))?
            .handle()?;
        let flags = protocol::OPEN_WRITE | protocol::OPEN_CREATE | protocol::OPEN_TRUNCATE;
        let target = match dest.request(|id| protocol::open(id, dest_path, flags)) {
            Ok(response) => response.handle(),
            Err(error) => Err(error),
        };
        let target = match target {
            Ok(target) => target,
            Err(error) => {
                let _ = self.request(|id| protocol::close(id, &source));
                return Err(error);
            }
        };
        let mut in_flight: VecDeque<(Receiver<Response>, u64)> = VecDeque::new();
        let mut confirmed = 0u64;
        let result = self
            .read_into(&source, size, cancel, &mut |offset, data| {
                let receiver = dest.send(|id| protocol::write(id, &target, offset, data))?;
                in_flight.push_back((receiver, data.len() as u64));
                if in_flight.len() >= WINDOW {
                    if let Some((receiver, len)) = in_flight.pop_front() {
                        dest.wait(receiver)?.ok()?;
                        confirmed += len;
                        progress(confirmed);
                    }
                }
                Ok(())
            })
            .and_then(|()| {
                while let Some((receiver, len)) = in_flight.pop_front() {
                    dest.wait(receiver)?.ok()?;
                    confirmed += len;
                    progress(confirmed);
                }
                Ok(())
            });
        let _ = self.request(|id| protocol::close(id, &source));
        let closed = dest
            .request(|id| protocol::close(id, &target))
            .and_then(Response::ok);
        match result.and(closed) {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = dest.remove(dest_path);
                Err(error)
            }
        }
    }

    /// Deletes a file, a link, or a folder with everything in it. Links to folders are removed,
    /// never followed.
    pub(crate) fn remove_tree(&self, path: &str) -> Result<(), String> {
        self.remove_tree_at(path, 0)
    }

    fn remove_tree_at(&self, path: &str, depth: usize) -> Result<(), String> {
        let attrs = self.request(|id| protocol::lstat(id, path))?.attrs()?;
        if !attrs.is_dir() {
            return self.remove(path);
        }
        if depth >= 64 {
            return Err("The folder is nested too deeply".to_string());
        }
        let base = path.trim_end_matches('/');
        for entry in self.list_dir(path)? {
            if entry.name.contains('/') {
                continue;
            }
            let child = format!("{base}/{}", entry.name);
            if entry.is_link {
                self.remove(&child)?;
            } else {
                self.remove_tree_at(&child, depth + 1)?;
            }
        }
        self.rmdir(path)
    }

    /// Ends the process; pending requests fail with "connection lost".
    pub(crate) fn shutdown(&self) {
        self.alive.store(false, Ordering::Release);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
    }
}

impl Drop for SftpClient {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn read_full(file: &mut File, buffer: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(filled)
}

/// Delivers replies until the stream ends; then every waiting request fails.
fn spawn_reader(mut stdout: ChildStdout, pending: Pending, alive: Arc<AtomicBool>) {
    thread::spawn(move || {
        while let Ok(body) = read_packet(&mut stdout) {
            let Ok((id, response)) = protocol::parse_response(&body) else {
                break;
            };
            let sender = pending.lock().ok().and_then(|mut map| map.remove(&id));
            if let Some(sender) = sender {
                // The request may have been given up (cancel, error): nobody listens then.
                let _ = sender.send(response);
            }
        }
        alive.store(false, Ordering::Release);
        if let Ok(mut map) = pending.lock() {
            map.clear();
        }
    });
}

/// Calls `send` at most every `interval`, and always for the last value.
pub(crate) struct Throttle {
    last: Option<Instant>,
    interval: Duration,
}

impl Throttle {
    pub(crate) fn new(interval: Duration) -> Self {
        Self {
            last: None,
            interval,
        }
    }

    pub(crate) fn ready(&mut self) -> bool {
        let now = Instant::now();
        if self
            .last
            .is_some_and(|last| now.duration_since(last) < self.interval)
        {
            return false;
        }
        self.last = Some(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const SFTP_SERVER: &str = "/usr/lib/ssh/sftp-server";

    /// The local sftp-server as transport, so no SSH server is needed.
    fn local_client() -> Option<SftpClient> {
        let path = [
            SFTP_SERVER,
            "/usr/lib/openssh/sftp-server",
            "/usr/libexec/sftp-server",
        ]
        .into_iter()
        .find(|path| Path::new(path).is_file())?;
        Some(SftpClient::start(Command::new(path), "missing").unwrap())
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("crabshell-sftp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn text(path: &Path) -> String {
        path.to_str().unwrap().to_string()
    }

    #[test]
    fn maps_ssh_errors() {
        assert!(ssh_error("user@h: Permission denied (publickey,password).").contains("key"));
        assert!(ssh_error("Host key verification failed.\r\n").contains("host key"));
        assert!(ssh_error("ssh: Could not resolve hostname x: Name").contains("not found"));
        assert_eq!(ssh_error("first\nsomething else\n\n"), "something else");
        assert_eq!(ssh_error(""), "The file connection failed");
    }

    #[test]
    fn browses_and_changes_files() {
        let Some(client) = local_client() else {
            return;
        };
        let dir = temp_dir("browse");
        let base = text(&dir);
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&dir, dir.join("loop")).unwrap();

        assert_eq!(client.realpath(&format!("{base}/./")).unwrap(), base);
        client.mkdir(&format!("{base}/sub")).unwrap();
        let mut entries = client.list_dir(&base).unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<_> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert!(names.starts_with(&["a.txt"]) && names.contains(&"sub"));
        let file = &entries[0];
        assert!(!file.is_dir && file.size == 5);
        assert!(entries
            .iter()
            .any(|entry| entry.name == "sub" && entry.is_dir));
        #[cfg(unix)]
        assert!(entries
            .iter()
            .any(|entry| entry.name == "loop" && entry.is_link && entry.is_dir));

        client
            .rename(&format!("{base}/a.txt"), &format!("{base}/b.txt"))
            .unwrap();
        assert!(client.exists(&format!("{base}/b.txt")).unwrap());
        assert!(!client.exists(&format!("{base}/a.txt")).unwrap());
        client.remove(&format!("{base}/b.txt")).unwrap();
        client.rmdir(&format!("{base}/sub")).unwrap();
        assert_eq!(
            client.list_dir(&format!("{base}/missing")).unwrap_err(),
            "The file or folder does not exist"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn uploads_and_downloads_large_files() {
        let Some(client) = local_client() else {
            return;
        };
        let dir = temp_dir("transfer");
        // Not a multiple of the chunk size, and more than one window of chunks.
        let content: Vec<u8> = (0..1_234_567u32).map(|value| (value % 251) as u8).collect();
        let source = dir.join("source.bin");
        std::fs::write(&source, &content).unwrap();
        let remote = text(&dir.join("remote.bin"));
        let cancel = AtomicBool::new(false);

        let mut last = 0;
        client
            .upload(&source, &remote, &cancel, &mut |bytes| last = bytes)
            .unwrap();
        assert_eq!(last, content.len() as u64);
        assert_eq!(std::fs::read(&remote).unwrap(), content);

        let target = dir.join("target.bin");
        client
            .download(&remote, &target, &cancel, &mut |_| {})
            .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), content);

        // Empty files work too.
        let empty = dir.join("empty");
        std::fs::write(&empty, "").unwrap();
        client
            .upload(
                &empty,
                &text(&dir.join("empty-remote")),
                &cancel,
                &mut |_| {},
            )
            .unwrap();
        client
            .download(
                &text(&dir.join("empty-remote")),
                &dir.join("empty-back"),
                &cancel,
                &mut |_| {},
            )
            .unwrap();
        assert_eq!(std::fs::read(dir.join("empty-back")).unwrap(), b"");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cancelled_transfers_leave_no_partial_files() {
        let Some(client) = local_client() else {
            return;
        };
        let dir = temp_dir("cancel");
        let source = dir.join("big.bin");
        std::fs::write(&source, vec![7u8; 2_000_000]).unwrap();
        let cancel = AtomicBool::new(false);
        let remote = text(&dir.join("partial.bin"));
        let result = client.upload(&source, &remote, &cancel, &mut |bytes| {
            if bytes > 100_000 {
                cancel.store(true, Ordering::Relaxed);
            }
        });
        assert_eq!(result.unwrap_err(), CANCELLED);
        assert!(!Path::new(&remote).exists());

        let cancel = AtomicBool::new(false);
        let local = dir.join("partial-download.bin");
        let result = client.download(&text(&source), &local, &cancel, &mut |bytes| {
            if bytes > 100_000 {
                cancel.store(true, Ordering::Relaxed);
            }
        });
        assert_eq!(result.unwrap_err(), CANCELLED);
        assert!(!local.exists());

        let cancel = AtomicBool::new(false);
        let copied = text(&dir.join("partial-copy.bin"));
        let result = client.copy_to(&text(&source), &client, &copied, &cancel, &mut |bytes| {
            if bytes > 100_000 {
                cancel.store(true, Ordering::Relaxed);
            }
        });
        assert_eq!(result.unwrap_err(), CANCELLED);
        assert!(!Path::new(&copied).exists());
        // The connection still works afterwards.
        assert!(client.list_dir(&text(&dir)).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn copies_between_servers_and_removes_trees() {
        let (Some(first), Some(second)) = (local_client(), local_client()) else {
            return;
        };
        let dir = temp_dir("server-copy");
        let data: Vec<u8> = (0..1_000_000u32).map(|n| (n % 251) as u8).collect();
        std::fs::write(dir.join("a.bin"), &data).unwrap();
        let cancel = AtomicBool::new(false);
        let mut last = 0;
        first
            .copy_to(
                &text(&dir.join("a.bin")),
                &second,
                &text(&dir.join("b.bin")),
                &cancel,
                &mut |bytes| last = bytes,
            )
            .unwrap();
        assert_eq!(std::fs::read(dir.join("b.bin")).unwrap(), data);
        assert_eq!(last, data.len() as u64);

        let tree = dir.join("tree");
        std::fs::create_dir_all(tree.join("sub/deeper")).unwrap();
        std::fs::write(tree.join("sub/deeper/x.txt"), "x").unwrap();
        std::fs::write(tree.join("y.txt"), "y").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("keep"), tree.join("link")).unwrap();
        std::fs::create_dir_all(dir.join("keep")).unwrap();
        std::fs::write(dir.join("keep/z.txt"), "z").unwrap();
        first.remove_tree(&text(&tree)).unwrap();
        assert!(!tree.exists());
        assert!(
            dir.join("keep/z.txt").exists(),
            "links are removed, not followed"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

use std::{
    io::{Read, Write},
    path::Path,
    sync::Mutex,
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

/// A running interactive terminal process (SSH or local shell).
///
/// The methods take `&self` and lock only what they need, so `close` can stop the process
/// while a `write` is blocked on a program that no longer reads its input.
pub(crate) trait TerminalSession: Send + Sync {
    fn write(&self, data: &[u8]) -> Result<(), String>;
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String>;
    fn close(&self) -> Result<(), String>;
    /// Exit code of a process that ended on its own; waits briefly, since the output usually
    /// closes just before the process exits. None while it still runs or when unknown.
    fn exit_code(&self) -> Option<u32>;
}

pub(crate) type SessionReader = Box<dyn Read + Send>;

/// A process running inside a pseudo terminal.
pub(crate) struct PtySession {
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
}

const SESSION_CLOSED: &str = "The session is closed";
const SESSION_UNAVAILABLE: &str = "The session is unavailable";

impl PtySession {
    /// Starts OpenSSH for a saved host.
    pub(crate) fn connect_ssh(
        host: &str,
        port: Option<u16>,
        username: Option<&str>,
        identity_file: Option<&str>,
        options: &crate::conntest::SshOptions,
        cols: u16,
        rows: u16,
    ) -> Result<(Self, SessionReader), String> {
        validate_host(host)?;
        if port == Some(0) {
            return Err("Enter a valid SSH port (1-65535)".to_string());
        }
        if let Some(username) = username {
            validate_username(username)?;
        }
        validate_identity_file(identity_file)?;
        validate_size(cols, rows)?;
        Self::spawn(
            ssh_command(host, port, username, identity_file, options),
            cols,
            rows,
            SSH_MISSING,
        )
    }

    /// Starts the user's login shell ($SHELL, then the passwd entry, then /bin/sh; PowerShell
    /// on Windows) in the home directory.
    pub(crate) fn open_local_shell(cols: u16, rows: u16) -> Result<(Self, SessionReader), String> {
        validate_size(cols, rows)?;
        Self::spawn(
            local_shell_command(),
            cols,
            rows,
            "Could not start the local shell",
        )
    }

    fn spawn(
        command: CommandBuilder,
        cols: u16,
        rows: u16,
        spawn_error: &str,
    ) -> Result<(Self, SessionReader), String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| "Could not create a terminal session".to_string())?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|_| "Could not open the terminal output stream".to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|_| "Could not open the terminal input stream".to_string())?;
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|_| spawn_error.to_string())?;

        Ok((
            Self {
                writer: Mutex::new(Some(writer)),
                master: Mutex::new(Some(pair.master)),
                child: Mutex::new(Some(child)),
            },
            reader,
        ))
    }
}

impl TerminalSession for PtySession {
    fn exit_code(&self) -> Option<u32> {
        for _ in 0..20 {
            let mut child = self.child.lock().ok()?;
            match child.as_mut()?.try_wait() {
                Ok(Some(status)) => return Some(status.exit_code()),
                Ok(None) => {}
                Err(_) => return None,
            }
            drop(child);
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        None
    }

    fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| SESSION_UNAVAILABLE.to_string())?;
        let writer = writer.as_mut().ok_or_else(|| SESSION_CLOSED.to_string())?;
        writer
            .write_all(data)
            .and_then(|()| writer.flush())
            .map_err(|_| "Could not write to the terminal".to_string())
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        validate_size(cols, rows)?;
        let master = self
            .master
            .lock()
            .map_err(|_| SESSION_UNAVAILABLE.to_string())?;
        master
            .as_ref()
            .ok_or_else(|| SESSION_CLOSED.to_string())?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| "Could not resize the terminal".to_string())
    }

    fn close(&self) -> Result<(), String> {
        // A write blocked on a full PTY holds the writer lock; it fails once the process is
        // gone, and the writer is then dropped together with the session.
        if let Ok(mut writer) = self.writer.try_lock() {
            writer.take();
        }
        let mut close_error = None;

        let mut child = self
            .child
            .lock()
            .map_err(|_| SESSION_UNAVAILABLE.to_string())?;
        if let Some(child) = child.as_mut() {
            let should_wait = match child.try_wait() {
                Ok(Some(_)) => true,
                Ok(None) => match child.kill() {
                    Ok(()) => true,
                    Err(_) => matches!(child.try_wait(), Ok(Some(_))),
                },
                Err(_) => {
                    close_error = Some("Could not inspect the session process".to_string());
                    false
                }
            };

            if should_wait && child.wait().is_err() {
                close_error = Some("Could not wait for the session process to stop".to_string());
            } else if !should_wait && close_error.is_none() {
                close_error = Some("Could not stop the session process".to_string());
            }
        }
        child.take();
        drop(child);

        if let Ok(mut master) = self.master.lock() {
            master.take();
        }
        close_error.map_or(Ok(()), Err)
    }
}

/// Desktop launchers often start the app without TERM; xterm.js speaks xterm-256color.
fn set_terminal_env(command: &mut CommandBuilder) {
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
}

#[cfg(not(windows))]
pub(crate) const SSH_MISSING: &str = "Could not start OpenSSH. Check that `ssh` is installed.";
#[cfg(windows)]
pub(crate) const SSH_MISSING: &str =
    "Could not start OpenSSH. Install the OpenSSH client (Settings → System → Optional features).";

/// Unix: the login shell ($SHELL, passwd entry, /bin/sh). Windows: PowerShell 7 (`pwsh`) when
/// installed, otherwise Windows PowerShell, instead of portable-pty's default `cmd.exe`.
fn local_shell_command() -> CommandBuilder {
    #[cfg(windows)]
    let mut command = {
        let mut command = CommandBuilder::new(windows_shell());
        command.arg("-NoLogo");
        command
    };
    #[cfg(not(windows))]
    let mut command = CommandBuilder::new_default_prog();
    set_terminal_env(&mut command);
    command
}

#[cfg(windows)]
fn windows_shell() -> std::ffi::OsString {
    let on_path = |name: &str| {
        std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join(name))
                .find(|candidate| candidate.is_file())
        })
    };
    on_path("pwsh.exe")
        .or_else(|| on_path("powershell.exe"))
        .map(|path| path.into_os_string())
        .unwrap_or_else(|| "powershell.exe".into())
}

fn ssh_command(
    host: &str,
    port: Option<u16>,
    username: Option<&str>,
    identity_file: Option<&str>,
    options: &crate::conntest::SshOptions,
) -> CommandBuilder {
    let mut command = CommandBuilder::new("ssh");
    set_terminal_env(&mut command);
    command.arg("-tt");
    // Port 22 is not passed, so a `Port` from ~/.ssh/config still applies to aliases.
    if let Some(port) = port.filter(|port| *port != crate::storage::DEFAULT_SSH_PORT) {
        command.arg("-p");
        command.arg(port.to_string());
    }
    if let Some(username) = username {
        command.arg("-l");
        command.arg(username);
    }
    if let Some(identity_file) = identity_file {
        command.arg("-i");
        command.arg(identity_file);
        command.arg("-o");
        command.arg("IdentitiesOnly=yes");
    }
    if let Some(seconds) = options.keepalive_seconds {
        // A connection that died silently (VPN cut) ends after 3 unanswered keepalives with exit
        // code 255, so the pane can reconnect.
        command.arg("-o");
        command.arg(format!("ServerAliveInterval={seconds}"));
        command.arg("-o");
        command.arg("ServerAliveCountMax=3");
    }
    if let Some(proxy_command) = &options.proxy_command {
        // One argument; OpenSSH runs the value itself (see proxy.rs).
        command.arg("-o");
        command.arg(format!("ProxyCommand={proxy_command}"));
    }
    command.arg("--");
    command.arg(host);
    command
}

fn validate_identity_file(identity_file: Option<&str>) -> Result<(), String> {
    if let Some(identity_file) = identity_file {
        let path = Path::new(identity_file);
        if !path.is_absolute() || !path.is_file() {
            return Err("The selected private key file is unavailable".to_string());
        }
    }
    Ok(())
}

pub(crate) fn validate_host(host: &str) -> Result<(), String> {
    if host.is_empty()
        || host.len() > 255
        || host.starts_with('-')
        || !host.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'%')
        })
    {
        return Err("Enter a valid host name, address, or SSH config alias".to_string());
    }
    Ok(())
}

pub(crate) fn validate_username(username: &str) -> Result<(), String> {
    if username.is_empty()
        || username.len() > 64
        || username.starts_with('-')
        || !username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("Enter a valid SSH username".to_string());
    }
    Ok(())
}

// Kept small so that tiny windows still report their real size to the remote PTY.
const MIN_COLS: u16 = 10;
const MIN_ROWS: u16 = 2;

fn validate_size(cols: u16, rows: u16) -> Result<(), String> {
    if !(MIN_COLS..=500).contains(&cols) || !(MIN_ROWS..=200).contains(&rows) {
        return Err("The terminal size is outside the supported range".to_string());
    }
    Ok(())
}

pub(crate) fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty()
        || session_id.len() > 64
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Invalid session identifier".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::conntest::SshOptions;

    use super::{
        local_shell_command, ssh_command, validate_host, validate_identity_file,
        validate_session_id, validate_size, validate_username,
    };

    fn argv(command: &portable_pty::CommandBuilder) -> Vec<String> {
        command
            .get_argv()
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn accepts_common_hosts_and_config_aliases() {
        assert!(validate_host("build-box.example.net").is_ok());
        assert!(validate_host("office_ssh").is_ok());
        assert!(validate_host("2001:db8::1").is_ok());
    }

    #[test]
    fn rejects_option_like_or_shell_input_hosts() {
        assert!(validate_host("-oProxyCommand=bad").is_err());
        assert!(validate_host("host;touch-file").is_err());
        assert!(validate_host("host name").is_err());
    }

    #[test]
    fn rejects_option_like_usernames() {
        assert!(validate_username("admin_user").is_ok());
        assert!(validate_username("-oProxyCommand=bad").is_err());
        assert!(validate_username("user name").is_err());
    }

    #[test]
    fn builds_ssh_arguments_without_shell_interpolation() {
        let command = ssh_command(
            "node-a",
            Some(22),
            Some("admin"),
            None,
            &SshOptions::default(),
        );
        let arguments = argv(&command);
        assert_eq!(
            arguments,
            vec![
                "ssh".to_string(),
                "-tt".to_string(),
                "-l".to_string(),
                "admin".to_string(),
                "--".to_string(),
                "node-a".to_string(),
            ]
        );
    }

    #[test]
    fn passes_non_default_ports_only() {
        let command = ssh_command("node-a", Some(2222), None, None, &SshOptions::default());
        let arguments = argv(&command);
        assert_eq!(arguments, vec!["ssh", "-tt", "-p", "2222", "--", "node-a"]);
    }

    #[test]
    fn passes_selected_identity_as_a_single_argument() {
        let identity_file = "/home/alex/ssh keys/id_ed25519";
        let command = ssh_command(
            "node-a",
            None,
            Some("admin"),
            Some(identity_file),
            &SshOptions::default(),
        );
        let arguments = argv(&command);
        assert_eq!(
            arguments,
            vec![
                "ssh".to_string(),
                "-tt".to_string(),
                "-l".to_string(),
                "admin".to_string(),
                "-i".to_string(),
                identity_file.to_string(),
                "-o".to_string(),
                "IdentitiesOnly=yes".to_string(),
                "--".to_string(),
                "node-a".to_string(),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn reports_the_exit_code_of_a_process_that_ended() {
        use super::{PtySession, TerminalSession};
        use std::io::Read;
        let mut command = portable_pty::CommandBuilder::new("sh");
        command.args(["-c", "exit 255"]);
        let (session, mut reader) = PtySession::spawn(command, 80, 24, "sh missing").unwrap();
        let mut output = Vec::new();
        let _ = reader.read_to_end(&mut output);
        assert_eq!(session.exit_code(), Some(255));
        session.close().unwrap();
    }

    #[test]
    fn passes_the_proxy_command_as_one_option() {
        let options = SshOptions {
            proxy_command: Some("'/opt/crab' --proxy-connect socks5 p 1080 %h %p".into()),
            keepalive_seconds: Some(10),
        };
        let command = ssh_command("node-a", None, None, None, &options);
        let args = argv(&command);
        assert!(args.contains(&"ServerAliveInterval=10".to_string()));
        assert!(args.contains(&"ServerAliveCountMax=3".to_string()));
        let position = args
            .iter()
            .position(|arg| arg.starts_with("ProxyCommand="))
            .unwrap();
        assert_eq!(args[position - 1], "-o");
        assert_eq!(
            args[position],
            "ProxyCommand='/opt/crab' --proxy-connect socks5 p 1080 %h %p"
        );
        assert_eq!(&args[args.len() - 2..], ["--", "node-a"]);
        // Without proxy and keepalive nothing is added.
        assert!(!argv(&ssh_command(
            "node-a",
            None,
            None,
            None,
            &SshOptions::default()
        ))
        .iter()
        .any(|arg| arg.contains("ProxyCommand") || arg.contains("ServerAlive")));
    }

    #[test]
    fn local_shell_runs_the_default_login_shell_with_xterm_env() {
        let command = local_shell_command();
        assert!(command.is_default_prog());
        assert_eq!(
            command.get_env("TERM").and_then(|value| value.to_str()),
            Some("xterm-256color")
        );
    }

    /// Spawns the real login shell, so it depends on the machine's shell setup.
    /// Run with `SHELL=/bin/sh cargo test -- --ignored` (rich shell configs may wait for terminal replies).
    #[test]
    #[ignore]
    fn local_shell_runs_commands() {
        use super::{PtySession, TerminalSession};
        use std::io::Read;

        let (session, mut reader) = PtySession::open_local_shell(80, 24).unwrap();
        session.write(b"echo crab42\r").unwrap();
        let mut output = Vec::new();
        let mut buffer = [0_u8; 4096];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            output.extend_from_slice(&buffer[..count]);
            // The typed command is echoed once; the output line adds a second occurrence.
            if String::from_utf8_lossy(&output).matches("crab42").count() >= 2 {
                break;
            }
        }
        let _ = session.close();
        assert!(String::from_utf8_lossy(&output).matches("crab42").count() >= 2);
    }

    #[test]
    fn requires_selected_identity_path_to_be_an_existing_absolute_file() {
        assert!(validate_identity_file(None).is_ok());
        assert!(validate_identity_file(Some("relative-key")).is_err());
        assert!(validate_identity_file(Some("/path/that/does/not/exist")).is_err());
    }

    #[test]
    fn validates_terminal_dimensions_and_session_ids() {
        assert!(validate_size(120, 40).is_ok());
        assert!(validate_size(0, 40).is_err());
        assert!(validate_size(10, 2).is_ok());
        assert!(validate_size(9, 40).is_err());
        assert!(validate_session_id("f1d6e0d2-8e08").is_ok());
        assert!(validate_session_id("../session").is_err());
    }
}

use std::{
    io::{Read, Write},
    path::Path,
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

/// A running interactive terminal process (SSH or local shell).
pub(crate) trait TerminalSession: Send {
    fn write(&mut self, data: &[u8]) -> Result<(), String>;
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String>;
    fn close(&mut self) -> Result<(), String>;
}

pub(crate) type SessionReader = Box<dyn Read + Send>;

/// A process running inside a pseudo terminal.
pub(crate) struct PtySession {
    writer: Option<Box<dyn Write + Send>>,
    master: Option<Box<dyn MasterPty + Send>>,
    child: Option<Box<dyn Child + Send + Sync>>,
}

impl PtySession {
    /// Starts OpenSSH for a saved host.
    pub(crate) fn connect_ssh(
        host: &str,
        port: Option<u16>,
        username: Option<&str>,
        identity_file: Option<&str>,
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
            ssh_command(host, port, username, identity_file),
            cols,
            rows,
            "Could not start OpenSSH. Check that `ssh` is installed.",
        )
    }

    /// Starts the user's login shell ($SHELL, then the passwd entry, then /bin/sh)
    /// in the home directory.
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
                writer: Some(writer),
                master: Some(pair.master),
                child: Some(child),
            },
            reader,
        ))
    }
}

impl TerminalSession for PtySession {
    fn write(&mut self, data: &[u8]) -> Result<(), String> {
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| "The session is closed".to_string())?;
        writer
            .write_all(data)
            .and_then(|_| writer.flush())
            .map_err(|_| "Could not write to the terminal".to_string())
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        validate_size(cols, rows)?;
        let master = self
            .master
            .as_ref()
            .ok_or_else(|| "The session is closed".to_string())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| "Could not resize the terminal".to_string())
    }

    fn close(&mut self) -> Result<(), String> {
        self.writer.take();
        let mut close_error = None;

        if let Some(child) = self.child.as_mut() {
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

        self.child.take();
        self.master.take();
        close_error.map_or(Ok(()), Err)
    }
}

/// Desktop launchers often start the app without TERM; xterm.js speaks xterm-256color.
fn set_terminal_env(command: &mut CommandBuilder) {
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
}

fn local_shell_command() -> CommandBuilder {
    let mut command = CommandBuilder::new_default_prog();
    set_terminal_env(&mut command);
    command
}

fn ssh_command(
    host: &str,
    port: Option<u16>,
    username: Option<&str>,
    identity_file: Option<&str>,
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

fn validate_host(host: &str) -> Result<(), String> {
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

fn validate_username(username: &str) -> Result<(), String> {
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
    use super::{
        local_shell_command, ssh_command, validate_host, validate_identity_file,
        validate_session_id, validate_size, validate_username,
    };

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
        let command = ssh_command("node-a", Some(22), Some("admin"), None);
        let arguments: Vec<String> = command
            .get_argv()
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();
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
        let command = ssh_command("node-a", Some(2222), None, None);
        let arguments: Vec<String> = command
            .get_argv()
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();
        assert_eq!(arguments, vec!["ssh", "-tt", "-p", "2222", "--", "node-a"]);
    }

    #[test]
    fn passes_selected_identity_as_a_single_argument() {
        let identity_file = "/home/alex/ssh keys/id_ed25519";
        let command = ssh_command("node-a", None, Some("admin"), Some(identity_file));
        let arguments: Vec<String> = command
            .get_argv()
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();
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

        let (mut session, mut reader) = PtySession::open_local_shell(80, 24).unwrap();
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

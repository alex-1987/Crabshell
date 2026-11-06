use std::{
    io::{Read, Write},
    path::Path,
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

pub(crate) trait SshSession: Send {
    fn connect(
        host: &str,
        username: Option<&str>,
        identity_file: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<(Self, Box<dyn Read + Send>), String>
    where
        Self: Sized;

    fn write(&mut self, data: &[u8]) -> Result<(), String>;
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String>;
    fn close(&mut self) -> Result<(), String>;
}

pub(crate) struct OpenSshSession {
    writer: Option<Box<dyn Write + Send>>,
    master: Option<Box<dyn MasterPty + Send>>,
    child: Option<Box<dyn Child + Send + Sync>>,
}

impl SshSession for OpenSshSession {
    fn connect(
        host: &str,
        username: Option<&str>,
        identity_file: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<(Self, Box<dyn Read + Send>), String> {
        validate_host(host)?;
        if let Some(username) = username {
            validate_username(username)?;
        }
        validate_identity_file(identity_file)?;
        validate_size(cols, rows)?;

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
            .spawn_command(ssh_command(host, username, identity_file))
            .map_err(|_| "Could not start OpenSSH. Check that `ssh` is installed.".to_string())?;

        Ok((
            Self {
                writer: Some(writer),
                master: Some(pair.master),
                child: Some(child),
            },
            reader,
        ))
    }

    fn write(&mut self, data: &[u8]) -> Result<(), String> {
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| "The SSH session is closed".to_string())?;
        writer
            .write_all(data)
            .and_then(|_| writer.flush())
            .map_err(|_| "Could not write to the SSH terminal".to_string())
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        validate_size(cols, rows)?;
        let master = self
            .master
            .as_ref()
            .ok_or_else(|| "The SSH session is closed".to_string())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| "Could not resize the SSH terminal".to_string())
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
                    close_error = Some("Could not inspect the SSH process".to_string());
                    false
                }
            };

            if should_wait && child.wait().is_err() {
                close_error = Some("Could not wait for the SSH process to stop".to_string());
            } else if !should_wait && close_error.is_none() {
                close_error = Some("Could not stop the SSH process".to_string());
            }
        }

        self.child.take();
        self.master.take();
        close_error.map_or(Ok(()), Err)
    }
}

fn ssh_command(host: &str, username: Option<&str>, identity_file: Option<&str>) -> CommandBuilder {
    let mut command = CommandBuilder::new("ssh");
    command.arg("-tt");
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
        ssh_command, validate_host, validate_identity_file, validate_session_id, validate_size,
        validate_username,
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
        let command = ssh_command("node-a", Some("admin"), None);
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
    fn passes_selected_identity_as_a_single_argument() {
        let identity_file = "/home/alex/ssh keys/id_ed25519";
        let command = ssh_command("node-a", Some("admin"), Some(identity_file));
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

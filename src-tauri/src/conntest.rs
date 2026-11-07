//! "Test" in the server dialog: is the server reachable and does an SSH server answer?
//! No login, no host key prompt: resolve the target like OpenSSH would (`ssh -G`, so aliases
//! from ~/.ssh/config work), open a TCP connection and read the SSH version line.

use std::{
    io::Read,
    net::{TcpStream, ToSocketAddrs},
    process::Command,
    time::{Duration, Instant},
};

use serde::Serialize;

use crate::session::{validate_host, validate_username};

const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionTest {
    /// Host name or address OpenSSH would connect to, and the port.
    pub address: String,
    pub port: u16,
    /// The server's version line, e.g. "SSH-2.0-OpenSSH_9.6".
    pub banner: String,
    /// Time for the TCP connection in milliseconds.
    pub millis: u64,
}

#[derive(Debug, PartialEq)]
struct SshTarget {
    hostname: String,
    port: u16,
    /// Reached through ProxyJump/ProxyCommand: a direct test would check the wrong machine.
    proxied: bool,
}

#[tauri::command]
pub(crate) async fn test_connection(
    host: String,
    port: Option<u16>,
    username: Option<String>,
) -> Result<ConnectionTest, String> {
    tauri::async_runtime::spawn_blocking(move || run(&host, port, username.as_deref()))
        .await
        .map_err(|_| "The connection test failed".to_string())?
}

fn run(host: &str, port: Option<u16>, username: Option<&str>) -> Result<ConnectionTest, String> {
    let host = host.trim();
    validate_host(host)?;
    let username = username.map(str::trim).filter(|name| !name.is_empty());
    if let Some(username) = username {
        validate_username(username)?;
    }
    let target = resolve(host, port, username)?;
    if target.proxied {
        return Err(
            "This server is reached through ProxyJump or ProxyCommand; the test cannot check it directly"
                .to_string(),
        );
    }
    probe(&target)
}

/// Effective host name and port from `ssh -G` (no connection is made).
fn resolve(host: &str, port: Option<u16>, username: Option<&str>) -> Result<SshTarget, String> {
    let mut command = Command::new("ssh");
    command.arg("-G");
    if let Some(port) = port.filter(|port| *port != crate::storage::DEFAULT_SSH_PORT) {
        command.arg("-p").arg(port.to_string());
    }
    if let Some(username) = username {
        command.arg("-l").arg(username);
    }
    command.arg("--").arg(host);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashing up.
        command.creation_flags(0x0800_0000);
    }
    let output = command
        .output()
        .map_err(|_| crate::session::SSH_MISSING.to_string())?;
    if !output.status.success() {
        return Err("OpenSSH could not read the configuration for this host".to_string());
    }
    parse_ssh_config(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| "OpenSSH could not read the configuration for this host".to_string())
}

fn parse_ssh_config(text: &str) -> Option<SshTarget> {
    let mut hostname = None;
    let mut port = None;
    let mut proxied = false;
    for line in text.lines() {
        let Some((key, value)) = line.split_once(' ') else {
            continue;
        };
        let value = value.trim();
        match key.to_ascii_lowercase().as_str() {
            "hostname" => hostname = Some(value.to_string()),
            "port" => port = value.parse().ok(),
            "proxyjump" | "proxycommand" if !value.eq_ignore_ascii_case("none") => proxied = true,
            _ => {}
        }
    }
    Some(SshTarget {
        hostname: hostname.filter(|name| !name.is_empty())?,
        port: port?,
        proxied,
    })
}

fn probe(target: &SshTarget) -> Result<ConnectionTest, String> {
    let addresses: Vec<_> = (target.hostname.as_str(), target.port)
        .to_socket_addrs()
        .map_err(|_| "Host not found".to_string())?
        .collect();
    if addresses.is_empty() {
        return Err("Host not found".to_string());
    }

    let mut last_error = "Host not found".to_string();
    for address in addresses {
        let started = Instant::now();
        match TcpStream::connect_timeout(&address, TIMEOUT) {
            Ok(stream) => {
                let millis = started.elapsed().as_millis() as u64;
                let banner = read_banner(stream)?;
                return Ok(ConnectionTest {
                    address: target.hostname.clone(),
                    port: target.port,
                    banner,
                    millis,
                });
            }
            Err(error) => {
                last_error = match error.kind() {
                    std::io::ErrorKind::ConnectionRefused => {
                        "Connection refused: no SSH server on this port".to_string()
                    }
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
                        "No answer within 5 seconds".to_string()
                    }
                    _ => "The server cannot be reached".to_string(),
                }
            }
        }
    }
    Err(last_error)
}

/// The SSH version line ("SSH-2.0-…"); servers may send other lines before it.
fn read_banner(mut stream: TcpStream) -> Result<String, String> {
    stream
        .set_read_timeout(Some(TIMEOUT))
        .map_err(|_| "The server cannot be reached".to_string())?;
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 256];
    while buffer.len() < 2048 {
        let read = stream
            .read(&mut chunk)
            .map_err(|_| "The port answers, but no SSH server replied".to_string())?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(banner) = banner_line(&buffer) {
            return Ok(banner);
        }
    }
    Err("The port answers, but no SSH server replied".to_string())
}

fn banner_line(buffer: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(buffer);
    let complete = text.rfind('\n').map(|end| &text[..end])?;
    complete
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .find(|line| line.starts_with("SSH-"))
        .map(|line| line.chars().take(120).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_target_from_ssh_g_output() {
        let target = parse_ssh_config("user alex\nhostname 10.0.0.5\nport 2222\nproxyjump none\n");
        assert_eq!(
            target,
            Some(SshTarget {
                hostname: "10.0.0.5".into(),
                port: 2222,
                proxied: false
            })
        );
        let jumped = parse_ssh_config("hostname db\nport 22\nproxyjump bastion\n").unwrap();
        assert!(jumped.proxied);
        assert_eq!(parse_ssh_config("port 22\n"), None);
    }

    #[test]
    fn finds_the_ssh_version_line() {
        assert_eq!(
            banner_line(b"SSH-2.0-OpenSSH_9.6\r\n").as_deref(),
            Some("SSH-2.0-OpenSSH_9.6")
        );
        assert_eq!(
            banner_line(b"welcome\r\nSSH-2.0-dropbear\r\n").as_deref(),
            Some("SSH-2.0-dropbear")
        );
        assert_eq!(banner_line(b"SSH-2.0-incomplete"), None);
        assert_eq!(banner_line(b"HTTP/1.1 400 Bad Request\r\n"), None);
    }

    #[test]
    fn refuses_invalid_hosts_before_running_ssh() {
        assert!(run("-oProxyCommand=evil", None, None).is_err());
        assert!(run("host", None, Some("-bad")).is_err());
    }

    #[test]
    fn reports_a_closed_port() {
        // Port 1 on localhost is closed on any normal machine.
        let target = SshTarget {
            hostname: "127.0.0.1".into(),
            port: 1,
            proxied: false,
        };
        assert!(probe(&target)
            .unwrap_err()
            .starts_with("Connection refused"));
    }
}

#[cfg(test)]
mod network_tests {
    /// Real network check: `cargo test -- --ignored test_against_github --nocapture`.
    #[test]
    #[ignore]
    fn test_against_github() {
        let result = super::run("github.com", None, None);
        println!("{result:?}");
        assert!(result.unwrap().banner.starts_with("SSH-"));
    }
}

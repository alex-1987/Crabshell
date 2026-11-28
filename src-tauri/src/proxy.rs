//! Proxy for SSH connections (Settings → Proxy, per server "Connect through the proxy").
//!
//! OpenSSH reaches the server through `ProxyCommand`, and that command is Crabshell itself in a
//! small helper mode (`crabshell --proxy-connect …`): it talks SOCKS5 or HTTP CONNECT to the proxy
//! and then copies the SSH bytes between its stdin/stdout and the proxy connection. So no extra
//! program (nc, ncat, connect-proxy) is needed, on Linux or Windows.
//!
//! Proxy authentication is not supported: credentials would have to be stored, and passwords
//! are never stored in plain text.

use std::{
    io::{Read, Write},
    net::{IpAddr, Shutdown, TcpStream, ToSocketAddrs},
    thread,
    time::Duration,
};

use serde::Deserialize;

use crate::session::validate_host;

/// First argument of the helper mode.
pub(crate) const HELPER_FLAG: &str = "--proxy-connect";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// The proxy has this long to answer the handshake.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProxyKind {
    Socks5,
    Http,
}

impl ProxyKind {
    fn name(self) -> &'static str {
        match self {
            Self::Socks5 => "socks5",
            Self::Http => "http",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        match name {
            "socks5" => Some(Self::Socks5),
            "http" => Some(Self::Http),
            _ => None,
        }
    }
}

/// The proxy the frontend passes for a server that uses it (only when it is switched on and
/// filled in; otherwise the connection is direct).
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxyConfig {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
}

pub(crate) fn validate_proxy(proxy: &ProxyConfig) -> Result<(), String> {
    if validate_host(&proxy.host).is_err() || proxy.port == 0 {
        return Err("Enter a valid proxy host and port".to_string());
    }
    Ok(())
}

/// `ProxyCommand` value that starts the helper mode of this executable. OpenSSH runs it through
/// the shell on Unix, so the path is quoted; `%` is OpenSSH's token character and is doubled.
/// `%h %p` are the target host name and port after ~/.ssh/config is applied.
pub(crate) fn proxy_command(proxy: &ProxyConfig) -> Result<String, String> {
    validate_proxy(proxy)?;
    let exe = std::env::current_exe()
        .map_err(|_| "Could not find the Crabshell program for the proxy".to_string())?;
    let exe = exe
        .to_str()
        .ok_or_else(|| "Could not find the Crabshell program for the proxy".to_string())?;
    Ok(format!(
        "{} {HELPER_FLAG} {} {} {} %h %p",
        quote_program(exe),
        proxy.kind.name(),
        // validate_host allows `%` (IPv6 zone ids like fe80::1%eth0).
        proxy.host.replace('%', "%%"),
        proxy.port
    ))
}

fn quote_program(path: &str) -> String {
    let path = path.replace('%', "%%");
    if cfg!(windows) {
        // Windows paths cannot contain double quotes.
        format!("\"{path}\"")
    } else {
        format!("'{}'", path.replace('\'', "'\\''"))
    }
}

/// TCP connection to `host:port` through the proxy, ready for the SSH protocol. The proxy
/// resolves the host name (works for names only the proxy's network knows).
pub(crate) fn connect_through(
    proxy: &ProxyConfig,
    host: &str,
    port: u16,
) -> Result<TcpStream, String> {
    validate_proxy(proxy)?;
    let addresses: Vec<_> = (proxy.host.as_str(), proxy.port)
        .to_socket_addrs()
        .map_err(|_| "The proxy was not found".to_string())?
        .collect();
    let mut stream = None;
    for address in addresses {
        if let Ok(connected) = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
            stream = Some(connected);
            break;
        }
    }
    let mut stream = stream.ok_or_else(|| "The proxy cannot be reached".to_string())?;
    let unreachable = |_| "The proxy cannot be reached".to_string();
    stream
        .set_read_timeout(Some(HANDSHAKE_TIMEOUT))
        .map_err(unreachable)?;
    stream
        .set_write_timeout(Some(HANDSHAKE_TIMEOUT))
        .map_err(unreachable)?;
    match proxy.kind {
        ProxyKind::Socks5 => socks5_handshake(&mut stream, host, port)?,
        ProxyKind::Http => http_connect(&mut stream, host, port)?,
    }
    stream.set_read_timeout(None).map_err(unreachable)?;
    stream.set_write_timeout(None).map_err(unreachable)?;
    Ok(stream)
}

fn io_error(_: std::io::Error) -> String {
    "The proxy closed the connection".to_string()
}

/// RFC 1928 without authentication; the host name is sent as a domain name, IPs as addresses.
fn socks5_handshake(stream: &mut (impl Read + Write), host: &str, port: u16) -> Result<(), String> {
    stream.write_all(&[5, 1, 0]).map_err(io_error)?;
    let mut choice = [0u8; 2];
    stream.read_exact(&mut choice).map_err(io_error)?;
    match choice {
        [5, 0] => {}
        [5, 0xff] => {
            return Err("The proxy requires a login, which Crabshell does not support".to_string())
        }
        _ => return Err("The proxy does not speak SOCKS5".to_string()),
    }
    stream
        .write_all(&socks5_request(host, port)?)
        .map_err(io_error)?;

    let mut reply = [0u8; 4];
    stream.read_exact(&mut reply).map_err(io_error)?;
    if reply[0] != 5 {
        return Err("The proxy does not speak SOCKS5".to_string());
    }
    if reply[1] != 0 {
        return Err(socks5_error(reply[1]).to_string());
    }
    // Skip the bound address and port the proxy reports.
    let address_len = match reply[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).map_err(io_error)?;
            usize::from(len[0])
        }
        _ => return Err("The proxy does not speak SOCKS5".to_string()),
    };
    let mut rest = vec![0u8; address_len + 2];
    stream.read_exact(&mut rest).map_err(io_error)?;
    Ok(())
}

fn socks5_request(host: &str, port: u16) -> Result<Vec<u8>, String> {
    let mut request = vec![5, 1, 0];
    match host.trim_matches(['[', ']']).parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            request.push(1);
            request.extend_from_slice(&ip.octets());
        }
        Ok(IpAddr::V6(ip)) => {
            request.push(4);
            request.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            let name = host.as_bytes();
            let len = u8::try_from(name.len())
                .ok()
                .filter(|len| *len > 0)
                .ok_or_else(|| "The host name is too long for the proxy".to_string())?;
            request.push(3);
            request.push(len);
            request.extend_from_slice(name);
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    Ok(request)
}

fn socks5_error(code: u8) -> &'static str {
    match code {
        2 => "The proxy does not allow this connection",
        3 => "The proxy cannot reach the network of the server",
        4 => "The proxy cannot reach the server",
        5 => "The server refused the connection (through the proxy)",
        6 => "No answer from the server (through the proxy)",
        _ => "The proxy could not connect to the server",
    }
}

/// HTTP CONNECT tunnel; the answer is read byte by byte so no SSH data is swallowed.
fn http_connect(stream: &mut (impl Read + Write), host: &str, port: u16) -> Result<(), String> {
    let target = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n");
    stream.write_all(request.as_bytes()).map_err(io_error)?;

    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= 8192 || stream.read(&mut byte).map_err(io_error)? == 0 {
            return Err("The proxy does not speak HTTP".to_string());
        }
        head.push(byte[0]);
    }
    let status_line = String::from_utf8_lossy(&head);
    let status = status_line
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("HTTP/1."))
        .and_then(|rest| rest.get(2..5))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "The proxy does not speak HTTP".to_string())?;
    match status {
        200..=299 => Ok(()),
        407 => Err("The proxy requires a login, which Crabshell does not support".to_string()),
        403 => Err("The proxy does not allow this connection".to_string()),
        _ => Err(format!("The proxy refused the connection (HTTP {status})")),
    }
}

/// Helper mode: `crabshell --proxy-connect <socks5|http> <proxy host> <proxy port> <host> <port>`.
/// Returns the exit code, or None when the arguments are not the helper's (normal start).
pub fn run_helper(args: &[String]) -> Option<i32> {
    if args.get(1).map(String::as_str) != Some(HELPER_FLAG) {
        return None;
    }
    let parsed = (|| {
        let [kind, proxy_host, proxy_port, host, port] = args.get(2..)? else {
            return None;
        };
        let proxy = ProxyConfig {
            kind: ProxyKind::parse(kind)?,
            host: proxy_host.clone(),
            port: proxy_port.parse().ok()?,
        };
        // The target comes from OpenSSH (`%h`, possibly a HostName from ~/.ssh/config); it ends
        // up in the CONNECT line, so it gets the same check as any other host.
        validate_host(host).ok()?;
        Some((proxy, host.clone(), port.parse::<u16>().ok()?))
    })();
    let Some((proxy, host, port)) = parsed else {
        eprintln!("crabshell {HELPER_FLAG}: invalid arguments");
        return Some(2);
    };
    match connect_through(&proxy, &host, port) {
        Ok(stream) => Some(relay(stream)),
        Err(error) => {
            // OpenSSH shows this in the terminal.
            eprintln!("Crabshell proxy {}:{}: {error}", proxy.host, proxy.port);
            Some(1)
        }
    }
}

/// Copies stdin to the proxy connection and the connection to stdout until either side ends.
fn relay(stream: TcpStream) -> i32 {
    let Ok(mut upload) = stream.try_clone() else {
        return 1;
    };
    thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let _ = std::io::copy(&mut stdin, &mut upload);
        let _ = upload.shutdown(Shutdown::Write);
    });
    let mut download = stream;
    let mut stdout = std::io::stdout().lock();
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match download.read(&mut buffer) {
            Ok(0) => return 0,
            Ok(read) => {
                if stdout.write_all(&buffer[..read]).is_err() || stdout.flush().is_err() {
                    return 0;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Answers from a fake proxy; everything written to it is collected.
    struct FakeProxy {
        answer: Cursor<Vec<u8>>,
        written: Vec<u8>,
    }

    impl FakeProxy {
        fn new(answer: &[u8]) -> Self {
            Self {
                answer: Cursor::new(answer.to_vec()),
                written: Vec::new(),
            }
        }
    }

    impl Read for FakeProxy {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.answer.read(buffer)
        }
    }

    impl Write for FakeProxy {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.written.extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn socks5_sends_names_and_addresses() {
        assert_eq!(
            socks5_request("web", 22).unwrap(),
            [5, 1, 0, 3, 3, b'w', b'e', b'b', 0, 22]
        );
        assert_eq!(
            socks5_request("10.0.0.5", 2222).unwrap(),
            [5, 1, 0, 1, 10, 0, 0, 5, 0x08, 0xae]
        );
        assert_eq!(socks5_request("::1", 22).unwrap()[3], 4);
        assert!(socks5_request(&"a".repeat(256), 22).is_err());
    }

    #[test]
    fn socks5_handshake_succeeds_and_reports_errors() {
        let mut ok = FakeProxy::new(&[5, 0, 5, 0, 0, 1, 127, 0, 0, 1, 0, 80, b'S']);
        socks5_handshake(&mut ok, "web", 22).unwrap();
        assert_eq!(&ok.written[..3], &[5, 1, 0]);
        // The SSH data after the reply is left unread.
        assert_eq!(ok.answer.position(), 12);

        let mut login = FakeProxy::new(&[5, 0xff]);
        assert!(socks5_handshake(&mut login, "web", 22)
            .unwrap_err()
            .contains("login"));

        let mut refused = FakeProxy::new(&[5, 0, 5, 5, 0, 1, 0, 0, 0, 0, 0, 0]);
        assert!(socks5_handshake(&mut refused, "web", 22)
            .unwrap_err()
            .contains("refused"));
    }

    #[test]
    fn http_connect_reads_only_the_response_head() {
        let mut ok = FakeProxy::new(b"HTTP/1.1 200 Connection established\r\n\r\nSSH-2.0-x");
        http_connect(&mut ok, "web", 22).unwrap();
        assert_eq!(
            ok.written,
            b"CONNECT web:22 HTTP/1.1\r\nHost: web:22\r\n\r\n"
        );
        assert_eq!(ok.answer.position(), 39);

        let mut ipv6 = FakeProxy::new(b"HTTP/1.0 200 OK\r\n\r\n");
        http_connect(&mut ipv6, "2001:db8::1", 22).unwrap();
        assert!(ipv6.written.starts_with(b"CONNECT [2001:db8::1]:22 "));

        let mut login = FakeProxy::new(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        assert!(http_connect(&mut login, "web", 22)
            .unwrap_err()
            .contains("login"));

        let mut garbage = FakeProxy::new(b"SSH-2.0-OpenSSH\r\n");
        assert!(http_connect(&mut garbage, "web", 22).is_err());
    }

    #[test]
    fn quotes_the_program_for_the_shell() {
        if cfg!(windows) {
            assert_eq!(quote_program(r"C:\Apps\crab.exe"), r#""C:\Apps\crab.exe""#);
        } else {
            assert_eq!(
                quote_program("/opt/my app/crabshell"),
                "'/opt/my app/crabshell'"
            );
            assert_eq!(quote_program("/tmp/it's%x"), "'/tmp/it'\\''s%%x'");
        }
    }

    #[test]
    fn builds_the_proxy_command() {
        let proxy = ProxyConfig {
            kind: ProxyKind::Http,
            host: "proxy.example.com".into(),
            port: 8080,
        };
        let command = proxy_command(&proxy).unwrap();
        assert!(command.ends_with(" --proxy-connect http proxy.example.com 8080 %h %p"));

        let bad = ProxyConfig {
            host: "-oEvil".into(),
            ..proxy
        };
        assert!(proxy_command(&bad).is_err());

        let zoned = ProxyConfig {
            host: "fe80::1%eth0".into(),
            ..bad
        };
        assert!(proxy_command(&zoned)
            .unwrap()
            .ends_with(" http fe80::1%%eth0 8080 %h %p"));
    }

    #[test]
    fn helper_mode_only_starts_with_its_flag() {
        assert_eq!(run_helper(&["crabshell".into()]), None);
        assert_eq!(run_helper(&["crabshell".into(), "--other".into()]), None);
        assert_eq!(
            run_helper(&["crabshell".into(), HELPER_FLAG.into(), "socks5".into()]),
            Some(2)
        );
    }

    #[test]
    fn helper_mode_refuses_invalid_targets() {
        let args = |host: &str| -> Vec<String> {
            [
                "crabshell",
                HELPER_FLAG,
                "http",
                "proxy",
                "8080",
                host,
                "22",
            ]
            .map(String::from)
            .to_vec()
        };
        assert_eq!(run_helper(&args("web\r\nX-Evil: 1")), Some(2));
        assert_eq!(
            run_helper(&args(
                "web
X-Evil: 1"
            )),
            Some(2)
        );
        assert_eq!(run_helper(&args("")), Some(2));
    }
}

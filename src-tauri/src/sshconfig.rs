//! Import from ~/.ssh/config: lists the concrete `Host` aliases so the user can pick which ones
//! become saved servers. Only the alias is saved; OpenSSH still resolves HostName, User, Port,
//! keys and ProxyJump from the config when connecting. The other values are read here only to
//! show them in the import list.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

use crate::session::validate_host;

/// Include depth OpenSSH allows as well.
const MAX_INCLUDE_DEPTH: usize = 16;
/// Larger files are skipped; a config is a few kilobytes.
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_HOSTS: usize = 1000;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshConfigHost {
    pub alias: String,
    /// Empty when the block sets no HostName (then the alias is the host name).
    pub hostname: String,
    pub user: String,
    pub port: Option<u16>,
    /// Reached through ProxyJump or ProxyCommand.
    pub proxied: bool,
}

#[tauri::command]
pub(crate) async fn ssh_config_hosts(app: tauri::AppHandle) -> Result<Vec<SshConfigHost>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Could not find the home directory".to_string())?;
    tauri::async_runtime::spawn_blocking(move || read_user_config(&home))
        .await
        .map_err(|_| "Could not read ~/.ssh/config".to_string())
}

fn read_user_config(home: &Path) -> Vec<SshConfigHost> {
    let ssh_dir = home.join(".ssh");
    let Some(text) = read_small_file(&ssh_dir.join("config")) else {
        return Vec::new();
    };
    let mut include = |pattern: &str| {
        expand_include(pattern, home, &ssh_dir)
            .iter()
            .filter_map(|path| read_small_file(path))
            .collect()
    };
    parse_config(&text, &mut include)
}

fn read_small_file(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Files for one `Include` argument: `~` is the home directory, relative paths start in ~/.ssh,
/// and `*`/`?` are allowed in the file name (not in directory names). Sorted like OpenSSH.
fn expand_include(pattern: &str, home: &Path, ssh_dir: &Path) -> Vec<PathBuf> {
    let path = if let Some(rest) = pattern.strip_prefix("~/") {
        home.join(rest)
    } else if Path::new(pattern).is_absolute() {
        PathBuf::from(pattern)
    } else {
        ssh_dir.join(pattern)
    };
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    if !name.contains(['*', '?']) {
        return vec![path];
    }
    let Some(parent) = path.parent() else {
        return Vec::new();
    };
    if parent.to_string_lossy().contains(['*', '?']) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|file| wildcard_match(name, file))
        })
        .map(|entry| entry.path())
        .collect();
    files.sort();
    files
}

/// `*` and `?` matching as in OpenSSH patterns; a leading dot must be matched literally.
fn wildcard_match(pattern: &str, text: &str) -> bool {
    if text.starts_with('.') && !pattern.starts_with('.') {
        return false;
    }
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    let (mut p, mut t) = (0, 0);
    let mut backtrack: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            backtrack = Some((p, t));
            p += 1;
        } else if let Some((star, matched)) = backtrack {
            p = star + 1;
            t = matched + 1;
            backtrack = Some((star, matched + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|&char| char == '*')
}

struct Parser<'a> {
    hosts: Vec<SshConfigHost>,
    /// Indexes into `hosts` the current `Host` block applies to (empty after `Match`).
    current: Vec<usize>,
    include: &'a mut dyn FnMut(&str) -> Vec<String>,
}

/// Concrete aliases in file order. `include` returns the contents of the files an `Include`
/// argument names.
fn parse_config(text: &str, include: &mut dyn FnMut(&str) -> Vec<String>) -> Vec<SshConfigHost> {
    let mut parser = Parser {
        hosts: Vec::new(),
        current: Vec::new(),
        include,
    };
    parser.parse(text, 0);
    parser.hosts
}

impl Parser<'_> {
    fn parse(&mut self, text: &str, depth: usize) {
        for line in text.lines() {
            let Some((keyword, args)) = split_line(line) else {
                continue;
            };
            match keyword.as_str() {
                "host" => self.start_host(&args),
                "match" => self.current.clear(),
                "include" if depth < MAX_INCLUDE_DEPTH => {
                    // Lines of an included file belong to the block that includes it until the
                    // file starts its own; afterwards that block continues.
                    let outer = self.current.clone();
                    for pattern in &args {
                        for included in (self.include)(pattern) {
                            self.parse(&included, depth + 1);
                        }
                    }
                    self.current = outer;
                }
                // The first value obtained wins, as in OpenSSH.
                "hostname" => self.set(&args, |host, value| {
                    if host.hostname.is_empty() {
                        host.hostname = value.to_string();
                    }
                }),
                "user" => self.set(&args, |host, value| {
                    if host.user.is_empty() {
                        host.user = value.to_string();
                    }
                }),
                "port" => self.set(&args, |host, value| {
                    if host.port.is_none() {
                        host.port = value.parse().ok().filter(|port| *port != 0);
                    }
                }),
                "proxyjump" | "proxycommand" => {
                    let proxied = args
                        .first()
                        .is_some_and(|value| !value.eq_ignore_ascii_case("none"));
                    self.set(&args, |host, _| host.proxied |= proxied);
                }
                _ => {}
            }
        }
    }

    fn start_host(&mut self, patterns: &[String]) {
        self.current.clear();
        for pattern in patterns {
            // Wildcards and negations are rules for other hosts, not servers of their own.
            if pattern.contains(['*', '?', '!']) || validate_host(pattern).is_err() {
                continue;
            }
            let index = match self
                .hosts
                .iter()
                .position(|host| host.alias.eq_ignore_ascii_case(pattern))
            {
                Some(index) => index,
                None if self.hosts.len() < MAX_HOSTS => {
                    self.hosts.push(SshConfigHost {
                        alias: pattern.clone(),
                        ..SshConfigHost::default()
                    });
                    self.hosts.len() - 1
                }
                None => continue,
            };
            if !self.current.contains(&index) {
                self.current.push(index);
            }
        }
    }

    fn set(&mut self, args: &[String], apply: impl Fn(&mut SshConfigHost, &str)) {
        let Some(value) = args.first() else {
            return;
        };
        for &index in &self.current {
            apply(&mut self.hosts[index], value);
        }
    }
}

/// Keyword (lower case) and arguments of a config line; `Key value`, `Key=value` and double
/// quotes as OpenSSH accepts them. None for empty lines and comments.
fn split_line(line: &str) -> Option<(String, Vec<String>)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line
        .find(|char: char| char.is_whitespace() || char == '=')
        .unwrap_or(line.len());
    let keyword = line[..end].to_ascii_lowercase();
    let rest = line[end..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest);
    let mut args = Vec::new();
    let mut chars = rest.chars().peekable();
    loop {
        while chars.next_if(|char| char.is_whitespace()).is_some() {}
        let Some(&first) = chars.peek() else {
            break;
        };
        if first == '#' {
            break;
        }
        let mut arg = String::new();
        if first == '"' {
            chars.next();
            for char in chars.by_ref() {
                if char == '"' {
                    break;
                }
                arg.push(char);
            }
        } else {
            while let Some(char) = chars.next_if(|char| !char.is_whitespace()) {
                arg.push(char);
            }
        }
        args.push(arg);
    }
    Some((keyword, args))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn parse(text: &str) -> Vec<SshConfigHost> {
        parse_config(text, &mut |_| Vec::new())
    }

    fn aliases(hosts: &[SshConfigHost]) -> Vec<&str> {
        hosts.iter().map(|host| host.alias.as_str()).collect()
    }

    #[test]
    fn lists_concrete_aliases_with_their_values() {
        let hosts = parse(
            "# comment\n\
             Host web\n\
             \tHostName 10.0.0.5\n\
             \tUser deploy\n\
             \tPort 2222\n\
             \n\
             Host db db-backup\n\
             HostName=db.internal\n\
             ProxyJump web\n",
        );
        assert_eq!(
            hosts,
            vec![
                SshConfigHost {
                    alias: "web".into(),
                    hostname: "10.0.0.5".into(),
                    user: "deploy".into(),
                    port: Some(2222),
                    proxied: false,
                },
                SshConfigHost {
                    alias: "db".into(),
                    hostname: "db.internal".into(),
                    proxied: true,
                    ..SshConfigHost::default()
                },
                SshConfigHost {
                    alias: "db-backup".into(),
                    hostname: "db.internal".into(),
                    proxied: true,
                    ..SshConfigHost::default()
                },
            ]
        );
    }

    #[test]
    fn skips_wildcards_negations_and_match_blocks() {
        let hosts = parse(
            "Host *\n  User root\n\
             Host *.example.com !bastion app?\n  User nobody\n\
             Host app\n  HostName app.example.com\n\
             Match host app\n  User wrong\n\
             Host -oProxyCommand=evil\n",
        );
        assert_eq!(aliases(&hosts), ["app"]);
        assert_eq!(hosts[0].user, "");
        assert_eq!(hosts[0].hostname, "app.example.com");
    }

    #[test]
    fn first_value_wins_and_aliases_are_unique() {
        let hosts = parse(
            "Host web\n  User first\n\
             Host WEB other\n  User second\n  Port 0\n",
        );
        assert_eq!(aliases(&hosts), ["web", "other"]);
        assert_eq!(hosts[0].user, "first");
        assert_eq!(hosts[1].user, "second");
        assert_eq!(hosts[1].port, None);
    }

    #[test]
    fn proxy_none_is_not_proxied() {
        let hosts =
            parse("Host direct\n  ProxyJump none\nHost via\n  ProxyCommand ssh -W %h:%p jump\n");
        assert!(!hosts[0].proxied);
        assert!(hosts[1].proxied);
    }

    #[test]
    fn follows_includes_and_keeps_the_outer_block() {
        let files: HashMap<&str, &str> = HashMap::from([
            ("config.d/*", "Host inner\n  User included\n"),
            ("loop", "Include loop\nHost looped\n"),
        ]);
        let mut include = |pattern: &str| {
            files
                .get(pattern)
                .map(|text| text.to_string())
                .into_iter()
                .collect()
        };
        let hosts = parse_config(
            "Include config.d/*\nHost outer\n  Include loop\n  User after\n",
            &mut include,
        );
        assert_eq!(aliases(&hosts), ["inner", "outer", "looped"]);
        assert_eq!(hosts[0].user, "included");
        // After the include the outer block applies again.
        assert_eq!(hosts[1].user, "after");
    }

    #[test]
    fn splits_quoted_arguments_and_comments() {
        assert_eq!(
            split_line("  IdentityFile \"~/my keys/id\" # note"),
            Some(("identityfile".into(), vec!["~/my keys/id".into()]))
        );
        assert_eq!(
            split_line("Port=22"),
            Some(("port".into(), vec!["22".into()]))
        );
        assert_eq!(
            split_line("Port = 22"),
            Some(("port".into(), vec!["22".into()]))
        );
        assert_eq!(split_line("   # comment"), None);
        assert_eq!(split_line(""), None);
    }

    #[test]
    fn matches_file_name_wildcards() {
        assert!(wildcard_match("*", "work"));
        assert!(wildcard_match("*.conf", "work.conf"));
        assert!(!wildcard_match("*.conf", "work.conf.bak"));
        assert!(wildcard_match("host?", "host1"));
        assert!(!wildcard_match("host?", "host12"));
        assert!(wildcard_match("a*b*c", "aXbYbZc"));
        assert!(!wildcard_match("*", ".hidden"));
        assert!(wildcard_match(".*", ".hidden"));
    }

    #[test]
    fn expands_include_paths() {
        let home = Path::new("/home/user");
        let ssh = home.join(".ssh");
        assert_eq!(expand_include("work", home, &ssh), [ssh.join("work")]);
        assert_eq!(expand_include("~/other", home, &ssh), [home.join("other")]);
        assert_eq!(
            expand_include("/etc/ssh/extra", home, &ssh),
            [PathBuf::from("/etc/ssh/extra")]
        );
        assert!(expand_include("/nonexistent-dir/*", home, &ssh).is_empty());
    }
}

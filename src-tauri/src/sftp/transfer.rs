//! Uploads and downloads of files and whole folders: first a plan (folders to create, files to
//! copy, total size), then the copies one after another with one progress for the whole item.
//!
//! Names from the server are untrusted: a name with a path separator, "." or ".." would write
//! outside the target folder, so such entries are skipped. Links to folders are not followed
//! (no endless loops); links to files are copied as the file they point to.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

use super::client::{SftpClient, CANCELLED};

/// More would mean a mistake (e.g. a whole disk), not a folder to copy.
const MAX_FILES: usize = 100_000;
const MAX_DEPTH: usize = 64;

/// What one item (a file, or a folder with everything in it) copies.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Plan<Dir, File> {
    /// Folders to create, parents first.
    pub dirs: Vec<Dir>,
    /// (source, target, size, path shown while copying)
    pub files: Vec<(File, File, u64, String)>,
    pub total: u64,
    /// Entries left out: unsafe names, links to folders, unreadable folders.
    pub skipped: u32,
}

/// Progress of one item; `failed` files were skipped after an error, the rest went on.
pub(crate) struct Outcome {
    pub failed: u32,
    pub first_error: Option<String>,
}

/// A file or folder name from the server that is safe to use as one local path segment.
pub(crate) fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0'])
        && !(cfg!(windows) && name.contains(':'))
}

fn too_many() -> String {
    "The folder holds too many files (more than 100000)".to_string()
}

// ------------------------------------------------------------------ upload

/// Plan for a local file or folder going into the remote folder `remote_dir`.
pub(crate) fn plan_upload(
    source: &Path,
    remote_dir: &str,
) -> Result<Plan<String, PathBuf>, String> {
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| "The local file is unavailable".to_string())?;
    let remote = format!("{}/{name}", remote_dir.trim_end_matches('/'));
    let mut plan = Plan::default();
    let metadata = fs::metadata(source).map_err(|_| "The local file is unavailable".to_string())?;
    if metadata.is_dir() {
        plan.dirs.push(remote.clone());
        walk_local(source, &remote, &name, 0, &mut plan)?;
    } else {
        plan.total = metadata.len();
        plan.files.push((
            source.to_path_buf(),
            PathBuf::from(&remote),
            metadata.len(),
            name,
        ));
    }
    Ok(plan)
}

fn walk_local(
    dir: &Path,
    remote: &str,
    shown: &str,
    depth: usize,
    plan: &mut Plan<String, PathBuf>,
) -> Result<(), String> {
    if depth >= MAX_DEPTH {
        plan.skipped += 1;
        return Ok(());
    }
    let Ok(entries) = fs::read_dir(dir) else {
        plan.skipped += 1;
        return Ok(());
    };
    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let target = format!("{remote}/{name}");
        let label = format!("{shown}/{name}");
        // symlink_metadata: a link to a folder is not followed.
        let Ok(kind) = fs::symlink_metadata(&path) else {
            plan.skipped += 1;
            continue;
        };
        if kind.is_dir() {
            plan.dirs.push(target.clone());
            walk_local(&path, &target, &label, depth + 1, plan)?;
        } else if let Some(metadata) = fs::metadata(&path).ok().filter(|meta| meta.is_file()) {
            if plan.files.len() >= MAX_FILES {
                return Err(too_many());
            }
            plan.total += metadata.len();
            plan.files
                .push((path, PathBuf::from(target), metadata.len(), label));
        } else {
            // Links to folders, sockets, broken links.
            plan.skipped += 1;
        }
    }
    Ok(())
}

/// Creates a remote folder unless it is already there (folders merge).
fn ensure_remote_dir(client: &SftpClient, path: &str) -> Result<(), String> {
    match client.stat(path) {
        Ok(attrs) if attrs.is_dir() => Ok(()),
        Ok(_) => Err("A file with the name of a folder is in the way".to_string()),
        Err(_) => client.mkdir(path),
    }
}

pub(crate) fn run_upload(
    client: &SftpClient,
    plan: &Plan<String, PathBuf>,
    cancel: &AtomicBool,
    report: &mut dyn FnMut(u64, &str),
) -> Result<Outcome, String> {
    for dir in &plan.dirs {
        ensure_remote_dir(client, dir)?;
    }
    copy_files(plan, cancel, report, |source, target, progress| {
        client.upload(source, &target.to_string_lossy(), cancel, progress)
    })
}

// ------------------------------------------------------------------ download

/// Plan for a remote file or folder going into the local folder `local_dir` as `local_name`.
pub(crate) fn plan_download(
    client: &SftpClient,
    remote: &str,
    is_dir: bool,
    local_dir: &Path,
    local_name: &str,
) -> Result<Plan<PathBuf, PathBuf>, String> {
    let target = local_dir.join(local_name);
    let mut plan = Plan::default();
    if is_dir {
        plan.dirs.push(target.clone());
        walk_remote(client, remote, &target, local_name, 0, &mut plan)?;
    } else {
        let size = client.stat(remote)?.size.unwrap_or(0);
        plan.total = size;
        plan.files
            .push((PathBuf::from(remote), target, size, local_name.to_string()));
    }
    Ok(plan)
}

fn walk_remote(
    client: &SftpClient,
    remote: &str,
    local: &Path,
    shown: &str,
    depth: usize,
    plan: &mut Plan<PathBuf, PathBuf>,
) -> Result<(), String> {
    if depth >= MAX_DEPTH {
        plan.skipped += 1;
        return Ok(());
    }
    let mut entries = match client.list_dir(remote) {
        Ok(entries) => entries,
        // The top folder must be readable; deeper ones are skipped.
        Err(error) if depth == 0 => return Err(error),
        Err(_) => {
            plan.skipped += 1;
            return Ok(());
        }
    };
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    for entry in entries {
        if !safe_name(&entry.name) || (entry.is_link && entry.is_dir) {
            plan.skipped += 1;
            continue;
        }
        let source = format!("{}/{}", remote.trim_end_matches('/'), entry.name);
        let target = local.join(&entry.name);
        let label = format!("{shown}/{}", entry.name);
        if entry.is_dir {
            plan.dirs.push(target.clone());
            walk_remote(client, &source, &target, &label, depth + 1, plan)?;
        } else {
            if plan.files.len() >= MAX_FILES {
                return Err(too_many());
            }
            plan.total += entry.size;
            plan.files
                .push((PathBuf::from(source), target, entry.size, label));
        }
    }
    Ok(())
}

pub(crate) fn run_download(
    client: &SftpClient,
    plan: &Plan<PathBuf, PathBuf>,
    cancel: &AtomicBool,
    report: &mut dyn FnMut(u64, &str),
) -> Result<Outcome, String> {
    for dir in &plan.dirs {
        fs::create_dir_all(dir).map_err(|_| "Could not create the local folder".to_string())?;
    }
    copy_files(plan, cancel, report, |source, target, progress| {
        client.download(&source.to_string_lossy(), target, cancel, progress)
    })
}

/// A folder name next to the existing ones: "logs", else "logs (2)", "logs (3)" …
pub(crate) fn free_local_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    (2..1000)
        .map(|number| format!("{name} ({number})"))
        .find(|candidate| !dir.join(candidate).exists())
        .unwrap_or_else(|| format!("{name} (copy)"))
}

// ------------------------------------------------------------------ shared

/// Copies the plan's files; a failed file is counted and the rest goes on. Cancelling stops.
fn copy_files<Dir>(
    plan: &Plan<Dir, PathBuf>,
    cancel: &AtomicBool,
    report: &mut dyn FnMut(u64, &str),
    mut copy: impl FnMut(&Path, &Path, &mut dyn FnMut(u64)) -> Result<(), String>,
) -> Result<Outcome, String> {
    let mut outcome = Outcome {
        failed: plan.skipped,
        first_error: None,
    };
    let mut done = 0u64;
    for (source, target, size, shown) in &plan.files {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        report(done, shown);
        let result = copy(source, target, &mut |bytes| report(done + bytes, shown));
        match result {
            Ok(()) => {}
            Err(_) if cancel.load(Ordering::Relaxed) => return Err(CANCELLED.to_string()),
            Err(error) => {
                outcome.failed += 1;
                outcome.first_error.get_or_insert(error);
            }
        }
        done += size;
        report(done, shown);
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn local_client() -> Option<SftpClient> {
        let path = [
            "/usr/lib/ssh/sftp-server",
            "/usr/lib/openssh/sftp-server",
            "/usr/libexec/sftp-server",
        ]
        .into_iter()
        .find(|path| Path::new(path).is_file())?;
        Some(SftpClient::start(Command::new(path), "missing").unwrap())
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("crabshell-tree-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_unsafe_names() {
        for name in ["", ".", "..", "a/b", "../x", "a\\b", "nul\0"] {
            assert!(!safe_name(name), "{name:?}");
        }
        assert!(safe_name(".bashrc"));
        assert!(safe_name("file name.txt"));
    }

    #[test]
    fn picks_a_free_folder_name() {
        let dir = temp_dir("names");
        assert_eq!(free_local_name(&dir, "logs"), "logs");
        fs::create_dir(dir.join("logs")).unwrap();
        fs::create_dir(dir.join("logs (2)")).unwrap();
        assert_eq!(free_local_name(&dir, "logs"), "logs (3)");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn copies_whole_folders_both_ways() {
        let Some(client) = local_client() else {
            return;
        };
        let root = temp_dir("folders");
        // Local tree: site/index.html, site/css/a.css, site/empty/, site/big.bin
        let site = root.join("local/site");
        fs::create_dir_all(site.join("css")).unwrap();
        fs::create_dir_all(site.join("empty")).unwrap();
        fs::write(site.join("index.html"), "<h1>hi</h1>").unwrap();
        fs::write(site.join("css/a.css"), "body{}").unwrap();
        fs::write(site.join("big.bin"), vec![3u8; 300_000]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&site, site.join("loop")).unwrap();
        let remote = root.join("remote");
        fs::create_dir_all(&remote).unwrap();
        let remote_dir = remote.to_string_lossy().into_owned();
        let cancel = AtomicBool::new(false);

        let plan = plan_upload(&site, &remote_dir).unwrap();
        assert_eq!(plan.files.len(), 3);
        assert_eq!(plan.total, 300_000 + 11 + 6);
        #[cfg(unix)]
        assert_eq!(plan.skipped, 1, "the link to a folder is left out");
        let mut last = 0;
        let outcome = run_upload(&client, &plan, &cancel, &mut |bytes, _| last = bytes).unwrap();
        assert_eq!(outcome.failed, plan.skipped);
        assert_eq!(last, plan.total);
        assert_eq!(fs::read(remote.join("site/css/a.css")).unwrap(), b"body{}");
        assert!(remote.join("site/empty").is_dir());

        // Uploading again merges into the existing folder.
        fs::write(site.join("index.html"), "<h1>new</h1>").unwrap();
        run_upload(
            &client,
            &plan_upload(&site, &remote_dir).unwrap(),
            &cancel,
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(
            fs::read(remote.join("site/index.html")).unwrap(),
            b"<h1>new</h1>"
        );

        // Download the remote folder into a new local folder.
        let back = root.join("back");
        fs::create_dir_all(&back).unwrap();
        let remote_site = remote.join("site").to_string_lossy().into_owned();
        let plan = plan_download(&client, &remote_site, true, &back, "site").unwrap();
        let outcome = run_download(&client, &plan, &cancel, &mut |_, _| {}).unwrap();
        assert_eq!(outcome.failed, 0);
        assert_eq!(fs::read(back.join("site/big.bin")).unwrap().len(), 300_000);
        assert_eq!(fs::read(back.join("site/css/a.css")).unwrap(), b"body{}");
        assert!(back.join("site/empty").is_dir());
        fs::remove_dir_all(&root).unwrap();
    }
}

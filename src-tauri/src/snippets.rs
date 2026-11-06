//! Command snippets, stored in `snippets.json` in the app config directory.
//!
//! Snippet contents may contain sensitive commands, so they are never logged and never
//! included in error messages.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};

use crate::storage::write_json_atomic;

pub(crate) const SNIPPETS_FILE: &str = "snippets.json";
const MAX_SNIPPETS: usize = 1000;
const MAX_ID_LEN: usize = 64;
const MAX_NAME_CHARS: usize = 128;
/// Well below the 64 KiB limit of `write_to_session`, so a snippet always fits into one write.
const MAX_TEXT_BYTES: usize = 32 * 1024;
const MAX_TAGS: usize = 20;
const MAX_TAG_CHARS: usize = 32;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Snippet {
    pub id: String,
    pub name: String,
    pub text: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnippetList {
    pub snippets: Vec<Snippet>,
    /// The file was unreadable JSON and has been moved aside to `snippets.json.broken`.
    pub recovered: bool,
}

/// Serializes read-modify-write cycles on the snippets file.
#[derive(Default)]
pub(crate) struct SnippetStore {
    lock: Mutex<()>,
}

impl SnippetStore {
    pub(crate) fn list(&self, path: &Path) -> Result<SnippetList, String> {
        let _guard = self.guard()?;
        load(path)
    }

    pub(crate) fn save(&self, path: &Path, snippet: Snippet) -> Result<Vec<Snippet>, String> {
        let _guard = self.guard()?;
        let snippet = normalize(snippet)?;
        let mut snippets = load(path)?.snippets;
        if let Some(existing) = snippets.iter_mut().find(|item| item.id == snippet.id) {
            *existing = snippet;
        } else if snippets.len() >= MAX_SNIPPETS {
            return Err("Too many saved snippets".to_string());
        } else {
            snippets.push(snippet);
        }
        write_json_atomic(path, &snippets)?;
        Ok(snippets)
    }

    pub(crate) fn delete(&self, path: &Path, id: &str) -> Result<Vec<Snippet>, String> {
        let _guard = self.guard()?;
        let mut snippets = load(path)?.snippets;
        let before = snippets.len();
        snippets.retain(|item| item.id != id);
        if snippets.len() != before {
            write_json_atomic(path, &snippets)?;
        }
        Ok(snippets)
    }

    fn guard(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.lock
            .lock()
            .map_err(|_| "The snippet store is unavailable".to_string())
    }
}

/// Missing file: empty list. Broken file: moved aside, empty list, `recovered = true`.
/// Individual invalid entries are skipped instead of failing the whole list.
fn load(path: &Path) -> Result<SnippetList, String> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SnippetList {
                snippets: Vec::new(),
                recovered: false,
            });
        }
        Err(_) => return Err("Could not read a local Crabshell data file".to_string()),
    };

    let Ok(snippets) = serde_json::from_slice::<Vec<Snippet>>(&contents) else {
        // Keep the broken file for the user and start with an empty list.
        let _ = fs::rename(path, broken_path(path));
        return Ok(SnippetList {
            snippets: Vec::new(),
            recovered: true,
        });
    };

    let mut seen = std::collections::HashSet::new();
    let snippets = snippets
        .into_iter()
        .filter_map(|snippet| normalize(snippet).ok())
        .filter(|snippet| seen.insert(snippet.id.clone()))
        .take(MAX_SNIPPETS)
        .collect();
    Ok(SnippetList {
        snippets,
        recovered: false,
    })
}

fn broken_path(path: &Path) -> PathBuf {
    let mut broken = path.to_path_buf();
    broken.set_extension("json.broken");
    broken
}

fn normalize(snippet: Snippet) -> Result<Snippet, String> {
    let name = snippet.name.trim().to_string();
    let mut tags: Vec<String> = Vec::new();
    for tag in snippet.tags {
        let tag = tag.trim();
        if !tag.is_empty()
            && !tags
                .iter()
                .any(|existing| existing.to_lowercase() == tag.to_lowercase())
        {
            tags.push(tag.to_string());
        }
    }

    if snippet.id.is_empty()
        || snippet.id.len() > MAX_ID_LEN
        || name.is_empty()
        || name.chars().count() > MAX_NAME_CHARS
        || snippet.text.trim().is_empty()
        || snippet.text.len() > MAX_TEXT_BYTES
        || tags.len() > MAX_TAGS
        || tags.iter().any(|tag| tag.chars().count() > MAX_TAG_CHARS)
    {
        return Err("A snippet contains invalid fields".to_string());
    }

    Ok(Snippet {
        id: snippet.id,
        name,
        text: snippet.text,
        tags,
    })
}

#[cfg(test)]
mod tests {
    use super::{broken_path, Snippet, SnippetStore, MAX_TEXT_BYTES};
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };

    /// A fresh, empty directory per test (no extra test dependencies needed).
    fn test_dir() -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "crabshell-snippets-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn snippet(id: &str, name: &str, text: &str) -> Snippet {
        Snippet {
            id: id.to_string(),
            name: name.to_string(),
            text: text.to_string(),
            tags: Vec::new(),
        }
    }

    #[test]
    fn missing_file_loads_as_empty_list() {
        let dir = test_dir();
        let list = SnippetStore::default()
            .list(&dir.join("snippets.json"))
            .unwrap();
        assert!(list.snippets.is_empty());
        assert!(!list.recovered);
    }

    #[test]
    fn saves_and_loads_snippets() {
        let dir = test_dir();
        let path = dir.join("snippets.json");
        let store = SnippetStore::default();

        let mut first = snippet("a", "  Disk usage ", "df -h\n");
        first.tags = vec![" disk ".into(), "Disk".into(), "".into(), "ops".into()];
        store.save(&path, first).unwrap();
        store
            .save(&path, snippet("b", "Logs", "journalctl -f"))
            .unwrap();

        let list = store.list(&path).unwrap();
        assert_eq!(list.snippets.len(), 2);
        assert_eq!(list.snippets[0].name, "Disk usage");
        assert_eq!(list.snippets[0].text, "df -h\n", "text is stored unchanged");
        assert_eq!(list.snippets[0].tags, vec!["disk", "ops"]);
        assert!(!path.with_extension("json.tmp").exists());

        // Saving an existing id updates it in place.
        store.save(&path, snippet("a", "Disk", "du -sh *")).unwrap();
        let list = store.list(&path).unwrap();
        assert_eq!(list.snippets.len(), 2);
        assert_eq!(list.snippets[0].text, "du -sh *");

        let remaining = store.delete(&path, "a").unwrap();
        assert_eq!(remaining, vec![snippet("b", "Logs", "journalctl -f")]);
        assert_eq!(store.list(&path).unwrap().snippets, remaining);
    }

    #[test]
    fn broken_file_is_moved_aside_instead_of_failing() {
        let dir = test_dir();
        let path = dir.join("snippets.json");
        fs::write(&path, b"{ not json").unwrap();
        let store = SnippetStore::default();

        let list = store.list(&path).unwrap();
        assert!(list.snippets.is_empty());
        assert!(list.recovered);
        assert_eq!(fs::read(broken_path(&path)).unwrap(), b"{ not json");

        // Afterwards the store works normally again.
        store.save(&path, snippet("a", "Uptime", "uptime")).unwrap();
        let list = store.list(&path).unwrap();
        assert!(!list.recovered);
        assert_eq!(list.snippets.len(), 1);
    }

    #[test]
    fn invalid_entries_are_skipped_when_loading() {
        let dir = test_dir();
        let path = dir.join("snippets.json");
        fs::write(
            &path,
            r#"[{"id":"a","name":"Ok","text":"ls"},{"id":"","name":"x","text":"y"},{"name":"no id"},42]"#,
        )
        .unwrap();
        // 42 is not an object, so the array fails as a whole and is recovered.
        assert!(SnippetStore::default().list(&path).unwrap().recovered);

        fs::write(
            &path,
            r#"[{"id":"a","name":"Ok","text":"ls"},{"id":"","name":"x","text":"y"},{"id":"a","name":"Dup","text":"z"}]"#,
        )
        .unwrap();
        let list = SnippetStore::default().list(&path).unwrap();
        assert_eq!(list.snippets, vec![snippet("a", "Ok", "ls")]);
    }

    #[test]
    fn rejects_invalid_snippets() {
        let dir = test_dir();
        let path = dir.join("snippets.json");
        let store = SnippetStore::default();
        assert!(store.save(&path, snippet("", "Name", "ls")).is_err());
        assert!(store.save(&path, snippet("a", "   ", "ls")).is_err());
        assert!(store.save(&path, snippet("a", "Name", " \n")).is_err());
        assert!(store
            .save(&path, snippet("a", "Name", &"x".repeat(MAX_TEXT_BYTES + 1)))
            .is_err());
        assert!(!path.exists(), "nothing is written for invalid input");
    }
}

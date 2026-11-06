import { useEffect, useState } from "react";
import { t, translateBackend } from "./i18n";
import { deleteSnippet, listSnippets, saveSnippet, type Snippet } from "./snippets";

/** Snippet list (snippets.json) with load/save/delete and the panel's notice and error lines. */
export function useSnippets() {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** Snippet in the editor dialog (`id` empty for a new one), or null. */
  const [editing, setEditing] = useState<Snippet | null>(null);

  useEffect(() => {
    let mounted = true;
    listSnippets()
      .then((list) => {
        if (!mounted) return;
        setSnippets(list.snippets);
        if (list.recovered) setNotice(t("snippets.recovered"));
      })
      .catch((loadError: unknown) => {
        if (mounted) setError(t("snippets.loadFailed", { error: translateBackend(loadError) }));
      })
      .finally(() => {
        if (mounted) setReady(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const saveFailed = (saveError: unknown) => setError(t("snippets.saveFailed", { error: translateBackend(saveError) }));

  /** Saves and closes the editor; errors are thrown so the editor can show them. */
  async function store(snippet: Snippet) {
    setSnippets(await saveSnippet(snippet));
    setError("");
    setNotice(t("snippets.savedNotice"));
    setEditing(null);
  }

  function duplicate(snippet: Snippet) {
    store({ ...snippet, id: crypto.randomUUID(), name: t("snippets.copySuffix", { name: snippet.name }).slice(0, 128) }).catch(saveFailed);
  }

  function remove(snippet: Snippet) {
    deleteSnippet(snippet.id)
      .then((next) => {
        setSnippets(next);
        setError("");
        setNotice(t("snippets.deleted"));
      })
      .catch(saveFailed);
  }

  function edit(snippet: Snippet | null) {
    setNotice("");
    setEditing(snippet);
  }

  return { snippets, ready, error, notice, editing, store, duplicate, remove, edit, closeEditor: () => setEditing(null) };
}

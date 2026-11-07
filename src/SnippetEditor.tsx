import { useState, type FormEvent } from "react";
import Dialog from "./Dialog";
import { t, translateBackend } from "./i18n";
import { MAX_SNIPPET_BYTES, parseTags, type Snippet } from "./snippets";

/** An existing tag offered below the tags field. */
type TagChoice = { key: string; label: string };

type SnippetEditorProps = {
  /** `id` is empty for a new snippet. */
  snippet: Snippet;
  /** Tags of all saved snippets, offered as chips to add or remove with a click. */
  existingTags: TagChoice[];
  onSave: (snippet: Snippet) => Promise<void>;
  onClose: () => void;
};

export default function SnippetEditor({ snippet, existingTags, onSave, onClose }: SnippetEditorProps) {
  const [name, setName] = useState(snippet.name);
  const [tags, setTags] = useState(snippet.tags.join(", "));
  const [text, setText] = useState(snippet.text);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const chosen = new Set(parseTags(tags).map((tag) => tag.toLowerCase()));

  /** Adds an existing tag to the field, or removes it when it is already there. */
  function toggleTag(choice: TagChoice) {
    const current = parseTags(tags);
    const next = chosen.has(choice.key) ? current.filter((tag) => tag.toLowerCase() !== choice.key) : [...current, choice.label];
    setTags(next.join(", "));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return setError(t("snippetEditor.nameRequired"));
    if (!text.trim()) return setError(t("snippetEditor.textRequired"));
    if (new TextEncoder().encode(text).length > MAX_SNIPPET_BYTES) return setError(t("snippetEditor.tooLong"));
    setSaving(true);
    try {
      await onSave({ id: snippet.id || crypto.randomUUID(), name: name.trim(), text, tags: parseTags(tags) });
    } catch (saveError) {
      setError(t("snippets.saveFailed", { error: translateBackend(saveError) }));
      setSaving(false);
    }
  }

  return (
    <Dialog closeLabel={t("server.closeDialog")} onClose={onClose} title={snippet.id ? t("snippetEditor.editTitle") : t("snippetEditor.addTitle")} titleId="snippet-editor-title">
      <form className="editor-form" onSubmit={(event) => void submit(event)}>
        <label className="field-label" htmlFor="snippet-name">{t("snippetEditor.name")}</label>
        <input autoComplete="off" autoFocus id="snippet-name" maxLength={128} onChange={(event) => setName(event.target.value)} placeholder={t("snippetEditor.namePlaceholder")} value={name} />
        <label className="field-label" htmlFor="snippet-tags">{t("snippetEditor.tags")}</label>
        <input autoComplete="off" id="snippet-tags" onChange={(event) => setTags(event.target.value)} placeholder={t("snippetEditor.tagsPlaceholder")} spellCheck={false} value={tags} />
        {existingTags.length > 0 && (
          <div aria-label={t("snippetEditor.existingTags")} className="snippet-tags snippet-editor-tags" role="group">
            {existingTags.map((choice) => (
              <button aria-pressed={chosen.has(choice.key)} className="snippet-tag-button" key={choice.key} onClick={() => toggleTag(choice)} title={t(chosen.has(choice.key) ? "snippetEditor.removeTag" : "snippetEditor.addTag", { tag: choice.label })} type="button">{choice.label}</button>
            ))}
          </div>
        )}
        <label className="field-label" htmlFor="snippet-text">{t("snippetEditor.text")}</label>
        <textarea
          autoComplete="off"
          className="snippet-textarea"
          id="snippet-text"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Ctrl+Enter saves; plain Enter adds a line.
            if (event.key === "Enter" && event.ctrlKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={t("snippetEditor.textPlaceholder")}
          rows={7}
          title={t("snippetEditor.trailingHint")}
          spellCheck={false}
          value={text}
        />
        <div className="snippet-warning">{t("snippets.noPasswords")}</div>
        {error && <div aria-live="polite" className="editor-notice">{error}</div>}
        <div className="editor-actions">
          <button className="button button-secondary" onClick={onClose} type="button">{t("common.cancel")}</button>
          <button className="button button-primary" disabled={saving} type="submit">{t("snippetEditor.save")}</button>
        </div>
      </form>
    </Dialog>
  );
}

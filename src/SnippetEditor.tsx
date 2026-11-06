import { useState, type FormEvent } from "react";
import { t, translateBackend } from "./i18n";
import { MAX_SNIPPET_BYTES, parseTags, type Snippet } from "./snippets";

type SnippetEditorProps = {
  /** `id` is empty for a new snippet. */
  snippet: Snippet;
  onSave: (snippet: Snippet) => Promise<void>;
  onClose: () => void;
};

export default function SnippetEditor({ snippet, onSave, onClose }: SnippetEditorProps) {
  const [name, setName] = useState(snippet.name);
  const [tags, setTags] = useState(snippet.tags.join(", "));
  const [text, setText] = useState(snippet.text);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

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
    <div className="dialog-scrim" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
      <section aria-labelledby="snippet-editor-title" aria-modal="true" className="server-dialog" role="dialog">
        <header className="dialog-heading">
          <div><div className="page-eyebrow">{t("snippetEditor.eyebrow")}</div><h2 id="snippet-editor-title">{snippet.id ? t("snippetEditor.editTitle") : t("snippetEditor.addTitle")}</h2></div>
          <button aria-label={t("server.closeDialog")} className="icon-button" onClick={onClose} type="button">×</button>
        </header>
        <form className="editor-form" onSubmit={(event) => void submit(event)}>
          <label className="field-label" htmlFor="snippet-name">{t("snippetEditor.name")}</label>
          <input autoComplete="off" autoFocus id="snippet-name" maxLength={128} onChange={(event) => setName(event.target.value)} placeholder={t("snippetEditor.namePlaceholder")} value={name} />
          <label className="field-label" htmlFor="snippet-tags">{t("snippetEditor.tags")} <span>{t("snippetEditor.tagsHint")}</span></label>
          <input autoComplete="off" id="snippet-tags" onChange={(event) => setTags(event.target.value)} placeholder={t("snippetEditor.tagsPlaceholder")} spellCheck={false} value={tags} />
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
            spellCheck={false}
            value={text}
          />
          <div className="form-footnote">{t("snippetEditor.trailingHint")}</div>
          <div className="snippet-warning">{t("snippets.noPasswords")}</div>
          {error && <div aria-live="polite" className="editor-notice">{error}</div>}
          <div className="editor-actions">
            <button className="button button-secondary" onClick={onClose} type="button">{t("common.cancel")}</button>
            <button className="button button-primary" disabled={saving} type="submit">{t("snippetEditor.save")}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

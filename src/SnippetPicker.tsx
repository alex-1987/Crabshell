import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Dialog from "./Dialog";
import { t } from "./i18n";
import { filterSnippets, firstLine, isMultilineSnippet, type Snippet } from "./snippets";

type SnippetPickerProps = {
  snippets: Snippet[];
  canInsert: boolean;
  onInsert: (snippet: Snippet, execute: boolean) => void;
  onManage: () => void;
  onClose: () => void;
};

/** Quick picker (Ctrl+Shift+S): search, Enter pastes, Ctrl+Enter pastes and runs. */
export default function SnippetPicker({ snippets, canInsert, onInsert, onManage, onClose }: SnippetPickerProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => filterSnippets(snippets, query), [snippets, query]);
  const selected = results[Math.min(index, results.length - 1)] ?? null;

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
  }, [index, results]);

  function choose(snippet: Snippet | null, execute: boolean) {
    if (snippet && canInsert) onInsert(snippet, execute);
  }

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setIndex((current) => (Math.min(current, results.length - 1) + step + results.length) % results.length);
    } else if (event.key === "Enter") {
      // Let Enter activate the focused action button instead of pasting.
      const target = event.target as HTMLElement;
      if (target instanceof HTMLButtonElement && target.getAttribute("role") !== "option") return;
      event.preventDefault();
      choose(selected, event.ctrlKey);
    }
  }

  return (
    <Dialog className="snippet-picker" closeLabel={t("picker.close")} eyebrow={t("picker.eyebrow")} onClose={onClose} onKeyDown={handleKey} title={t("picker.title")} titleId="picker-title">
      <input
        aria-controls="snippet-results"
        aria-label={t("picker.search")}
        autoComplete="off"
        autoFocus
        className="snippet-search"
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("picker.search")}
        spellCheck={false}
        value={query}
      />
      {!canInsert && <div aria-live="polite" className="editor-notice snippet-picker-notice">{t("picker.noSession")}</div>}
      <div aria-label={t("snippets.saved")} className="snippet-results" id="snippet-results" ref={listRef} role="listbox">
        {results.length === 0 ? (
          <div className="sidebar-empty">{snippets.length === 0 ? t("snippets.empty") : t("picker.noResults")}</div>
        ) : results.map((snippet, position) => (
          <button
            aria-selected={snippet === selected}
            className="snippet-result"
            key={snippet.id}
            onClick={() => setIndex(position)}
            onDoubleClick={() => choose(snippet, false)}
            role="option"
            type="button"
          >
            <span className="snippet-result-name">{snippet.name}</span>
            {snippet.tags.length > 0 && <span className="snippet-tags">{snippet.tags.map((tag) => <span key={tag}>{tag}</span>)}</span>}
            <span className="snippet-line">{firstLine(snippet.text)}</span>
          </button>
        ))}
      </div>
      {selected && (
        <>
          <pre className="paste-preview snippet-preview">{selected.text.replace(/[\r\n]+$/, "")}</pre>
          {isMultilineSnippet(selected.text) && <div className="form-footnote">{t("paste.warning")}</div>}
        </>
      )}
      <div className="form-footnote snippet-keys">{t("picker.keys")}</div>
      <div className="editor-actions">
        <button className="button button-secondary" onClick={onManage} type="button">{t("picker.manage")}</button>
        <button className="button button-secondary" disabled={!selected || !canInsert} onClick={() => choose(selected, true)} title="Ctrl+Enter" type="button">{t("picker.run")}</button>
        <button className="button button-primary" disabled={!selected || !canInsert} onClick={() => choose(selected, false)} title="Enter" type="button">{t("picker.insert")}</button>
      </div>
    </Dialog>
  );
}

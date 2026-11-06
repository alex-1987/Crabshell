import { useState } from "react";
import { t } from "./i18n";
import { firstLine, isMultilineSnippet, type Snippet } from "./snippets";

type SnippetSidebarProps = {
  snippets: Snippet[];
  disabled: boolean;
  canInsert: boolean;
  /** Paste on double-click instead of a single click. */
  doubleClick: boolean;
  /** Tag filter (lower case) to highlight in the rows; clicking a row's tag sets it. */
  activeTag: string | null;
  onTag: (tag: string | null) => void;
  onInsert: (snippet: Snippet, execute: boolean) => void;
  onEdit: (snippet: Snippet) => void;
  onDuplicate: (snippet: Snippet) => void;
  onDelete: (snippet: Snippet) => void;
};

/** Snippet management in the sidebar: click (or double-click, see settings; Enter always works) pastes, row actions run, edit, duplicate, delete. */
export default function SnippetSidebar({ snippets, disabled, canInsert, doubleClick, activeTag, onTag, onInsert, onEdit, onDuplicate, onDelete }: SnippetSidebarProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  if (snippets.length === 0) return <div className="sidebar-empty">{t("snippets.empty")}</div>;

  return (
    <>
      {snippets.map((snippet) => {
        const lines = snippet.text.replace(/[\r\n]+$/, "").split(/\r\n|\r|\n/).length;
        return (
          <div className="saved-server snippet-row" key={snippet.id}>
            <button className="saved-server-main" disabled={disabled || !canInsert} onClick={(event) => { if (!doubleClick || event.detail === 0) onInsert(snippet, false); }} onDoubleClick={() => { if (doubleClick) onInsert(snippet, false); }} title={t(doubleClick ? "snippets.insertDouble" : "snippets.insert", { name: snippet.name })} type="button">
              <span className="saved-server-name">{snippet.name}</span>
              <span className="saved-server-host">{firstLine(snippet.text)}</span>
            </button>
            {confirmDeleteId === snippet.id ? (
              <div className="sidebar-delete-confirm" role="group" aria-label={t("snippets.delete", { name: snippet.name })}>
                <button className="text-action" onClick={() => setConfirmDeleteId(null)} type="button">{t("common.cancel")}</button>
                <button className="text-action text-danger" onClick={() => { setConfirmDeleteId(null); onDelete(snippet); }} type="button">{t("sidebar.remove")}</button>
              </div>
            ) : (
              <div className="saved-server-actions">
                <button aria-label={t("snippets.runNamed", { name: snippet.name })} className="icon-button row-icon-button snippet-run" disabled={disabled || !canInsert} onClick={() => onInsert(snippet, true)} title={t("snippets.run")} type="button"><span aria-hidden="true">▶</span></button>
                <button aria-label={t("snippets.edit", { name: snippet.name })} className="icon-button row-icon-button" disabled={disabled} onClick={() => onEdit(snippet)} title={t("sidebar.edit")} type="button"><span aria-hidden="true">✎</span></button>
                <button aria-label={t("snippets.duplicate", { name: snippet.name })} className="icon-button row-icon-button" disabled={disabled} onClick={() => onDuplicate(snippet)} title={t("settings.duplicate")} type="button"><span aria-hidden="true">⧉</span></button>
                <button aria-label={t("snippets.delete", { name: snippet.name })} className="icon-button row-icon-button" disabled={disabled} onClick={() => setConfirmDeleteId(snippet.id)} title={t("sidebar.delete")} type="button"><span aria-hidden="true">×</span></button>
              </div>
            )}
            {(snippet.tags.length > 0 || isMultilineSnippet(snippet.text)) && (
              <div className="snippet-tags snippet-row-tags">
                {isMultilineSnippet(snippet.text) && <span className="snippet-tag-lines">{t("snippets.multiline", { lines })}</span>}
                {snippet.tags.map((tag) => {
                  const key = tag.toLowerCase();
                  return (
                    <button aria-pressed={activeTag === key} className="snippet-tag-button" key={tag} onClick={() => onTag(activeTag === key ? null : key)} title={t("snippets.filterByTag", { tag })} type="button">{tag}</button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

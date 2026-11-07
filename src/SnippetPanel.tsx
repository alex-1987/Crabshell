import FilterChips from "./FilterChips";
import { t } from "./i18n";
import { withShortcut } from "./labels";
import SnippetSidebar from "./SnippetSidebar";
import { snippetTags, type Snippet } from "./snippets";
import { terminalStore } from "./terminalStore";

type SnippetPanelProps = {
  snippets: Snippet[];
  ready: boolean;
  error: string;
  notice: string;
  /** Selected tag (lower case) or null for all. */
  tagFilter: string | null;
  canInsert: boolean;
  doubleClick: boolean;
  onTagFilter: (tag: string | null) => void;
  onHide: () => void;
  onOpenPicker: () => void;
  onAdd: () => void;
  onEdit: (snippet: Snippet) => void;
  onDuplicate: (snippet: Snippet) => void;
  onDelete: (snippet: Snippet) => void;
  onInsert: (snippet: Snippet, execute: boolean) => void;
};

/** Right-hand snippet panel. */
export default function SnippetPanel(props: SnippetPanelProps) {
  const { snippets, ready, error, notice, tagFilter, onTagFilter } = props;
  const pickerLabel = withShortcut(t("snippets.openPicker"), terminalStore.shortcutLabel("snippets"));
  const chips = snippetTags(snippets);
  // A tag whose last snippet was deleted no longer filters.
  const activeTag = tagFilter !== null && chips.some((chip) => chip.key === tagFilter) ? tagFilter : null;
  const visible = activeTag === null ? snippets : snippets.filter((snippet) => snippet.tags.some((tag) => tag.toLowerCase() === activeTag));

  return (
    <aside aria-label={t("sidebar.snippets")} className="sidebar snippet-panel" id="snippet-panel">
      <div className="server-list-heading">
        <div><h1>{t("sidebar.snippets")}</h1><span>{snippets.length}</span></div>
        <div className="sidebar-heading-actions">
          <button aria-label={pickerLabel} className="icon-button" onClick={props.onOpenPicker} title={pickerLabel} type="button"><span aria-hidden="true">⌕</span></button>
          <button aria-label={t("snippets.add")} className="icon-button" disabled={!ready || Boolean(error)} onClick={props.onAdd} title={t("snippets.add")} type="button"><span aria-hidden="true">+</span></button>
          <button aria-label={t("snippetPanel.hide")} className="icon-button" onClick={props.onHide} title={t("snippetPanel.hide")} type="button"><span aria-hidden="true">›</span></button>
        </div>
      </div>
      {notice && <div aria-live="polite" className="page-notice">{notice}</div>}
      {ready && !error && <FilterChips active={activeTag} chips={chips} label={t("snippets.tagFilter")} onChange={onTagFilter} />}
      <nav aria-label={t("snippets.saved")} className="saved-server-list">
        {!ready ? <div className="sidebar-empty">{t("sidebar.loading")}</div> : error ? <div aria-live="polite" className="sidebar-storage-error">{error}</div> : (
          <SnippetSidebar
            activeTag={activeTag}
            canInsert={props.canInsert}
            disabled={!ready}
            doubleClick={props.doubleClick}
            onDelete={props.onDelete}
            onDuplicate={props.onDuplicate}
            onEdit={props.onEdit}
            onInsert={props.onInsert}
            onTag={onTagFilter}
            snippets={visible}
          />
        )}
      </nav>
      <div className="snippet-sidebar-hint">{t("snippets.noPasswords")}</div>
    </aside>
  );
}

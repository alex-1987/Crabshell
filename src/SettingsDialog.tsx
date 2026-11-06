import { useState } from "react";
import ColorField from "./ColorField";
import DesktopIntegration from "./DesktopIntegration";
import ShortcutList from "./ShortcutList";
import { DEFAULT_APPEARANCE_ID, MAX_FONT_SIZE, MIN_FONT_SIZE } from "./appearance";
import type { AppSettings, Appearance, ClickMode, ClipboardReadMode, SavedHost, ThemeMode } from "./terminalTypes";
import { languageFromLocale, translateBackend, languageNames, languages, t, type LanguageSetting, type MessageKey } from "./i18n";
import { themeModeCycle, themeModeLabel, UI_SCALE_MAX, UI_SCALE_MIN } from "./uiTheme";

type SettingsDialogProps = {
  settings: AppSettings;
  servers: SavedHost[];
  initialAppearanceId?: string;
  systemLocale: string | null;
  onSave: (settings: AppSettings) => Promise<void>;
  onClose: () => void;
};

type Section = "general" | "appearances" | "shortcuts";

const colorFields: { key: keyof Pick<Appearance, "foreground" | "background" | "cursor" | "selection" | "tabColor">; label: MessageKey }[] = [
  { key: "foreground", label: "settings.foreground" },
  { key: "background", label: "settings.background" },
  { key: "cursor", label: "settings.cursor" },
  { key: "selection", label: "settings.selection" },
  { key: "tabColor", label: "settings.tabColor" },
];

export default function SettingsDialog({ settings, servers, initialAppearanceId, systemLocale, onSave, onClose }: SettingsDialogProps) {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [section, setSection] = useState<Section>(initialAppearanceId ? "appearances" : "general");
  const [selectedId, setSelectedId] = useState(initialAppearanceId ?? settings.defaultAppearanceId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selected = draft.appearances.find((item) => item.id === selectedId) ?? draft.appearances[0];
  const nameInvalid = draft.appearances.some((item) => !item.name.trim());

  function updateAppearance(patch: Partial<Appearance>) {
    setDraft((current) => ({
      ...current,
      appearances: current.appearances.map((item) => (item.id === selected.id ? { ...item, ...patch } : item)),
    }));
  }

  function addAppearance(base: Appearance, name: string) {
    const appearance: Appearance = { ...base, id: crypto.randomUUID(), name };
    setDraft((current) => ({ ...current, appearances: [...current.appearances, appearance] }));
    setSelectedId(appearance.id);
  }

  function removeAppearance() {
    if (selected.id === DEFAULT_APPEARANCE_ID) return;
    const remaining = draft.appearances.filter((item) => item.id !== selected.id);
    setDraft((current) => ({
      ...current,
      appearances: remaining,
      defaultAppearanceId: current.defaultAppearanceId === selected.id ? DEFAULT_APPEARANCE_ID : current.defaultAppearanceId,
      localAppearanceId: current.localAppearanceId === selected.id ? "" : current.localAppearanceId,
    }));
    setSelectedId(DEFAULT_APPEARANCE_ID);
  }

  async function save() {
    if (nameInvalid) {
      setError(t("settings.nameRequired"));
      return;
    }
    setSaving(true);
    try {
      await onSave({
        ...draft,
        appearances: draft.appearances.map((item) => ({ ...item, name: item.name.trim() })),
      });
    } catch (saveError) {
      setError(t("notice.saveSettingsFailed", { error: translateBackend(saveError) }));
      setSaving(false);
    }
  }

  const usedBy = servers
    .filter((server) => server.appearanceId ? server.appearanceId === selected.id : selected.id === draft.defaultAppearanceId)
    .map((server) => server.label || server.host);
  if ((draft.localAppearanceId || draft.defaultAppearanceId) === selected.id) usedBy.unshift(t("settings.localShells"));

  return (
    <div className="dialog-scrim" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
      <section aria-labelledby="settings-title" aria-modal="true" className="server-dialog settings-dialog" role="dialog">
        {/* Sticky: title, Save/Cancel and the section tabs stay visible while the content scrolls. */}
        <div className="settings-top">
          <header className="dialog-heading settings-heading">
            <div><div className="page-eyebrow">CRABSHELL</div><h2 id="settings-title">{t("settings.title")}</h2></div>
            <div className="settings-top-actions">
              <button className="button button-secondary" onClick={onClose} type="button">{t("common.cancel")}</button>
              <button className="button button-primary" disabled={saving} onClick={() => void save()} type="button">{t("common.save")}</button>
              <button aria-label={t("settings.close")} className="icon-button" onClick={onClose} type="button">×</button>
            </div>
          </header>

          <div aria-label={t("settings.sections")} className="settings-sections" role="tablist">
            <button aria-selected={section === "general"} autoFocus className="settings-section-tab" onClick={() => setSection("general")} role="tab" type="button">{t("settings.general")}</button>
            <button aria-selected={section === "appearances"} className="settings-section-tab" onClick={() => setSection("appearances")} role="tab" type="button">{t("settings.designs")}</button>
            <button aria-selected={section === "shortcuts"} className="settings-section-tab" onClick={() => setSection("shortcuts")} role="tab" type="button">{t("settings.shortcuts")}</button>
          </div>
          {error && <div aria-live="polite" className="editor-notice settings-error">{error}</div>}
        </div>

        {section === "general" ? (
          <div className="settings-panel" role="tabpanel">
            <h3>{t("settings.display")}</h3>
            <label className="field-label" htmlFor="language">{t("settings.language")}</label>
            <select id="language" onChange={(event) => setDraft({ ...draft, language: event.target.value as LanguageSetting })} value={draft.language}>
              <option value="system">{t("settings.languageSystem", { name: languageNames[languageFromLocale(systemLocale) ?? languageFromLocale(navigator.language) ?? "en"] })}</option>
              {languages.map((language) => <option key={language} value={language}>{languageNames[language]}</option>)}
            </select>
            <label className="field-label" htmlFor="theme-mode">{t("settings.colorScheme")}</label>
            <select id="theme-mode" onChange={(event) => setDraft({ ...draft, themeMode: event.target.value as ThemeMode })} value={draft.themeMode}>
              {themeModeCycle.map((mode) => <option key={mode} value={mode}>{themeModeLabel(mode)}</option>)}
            </select>
            <label className="field-label" htmlFor="ui-scale">{t("settings.uiScale")} <span>{draft.uiScale} %</span></label>
            <div className="range-row">
              <input className="range-input" id="ui-scale" max={UI_SCALE_MAX} min={UI_SCALE_MIN} onChange={(event) => setDraft({ ...draft, uiScale: Number(event.target.value) })} step={5} type="range" value={draft.uiScale} />
              <button className="text-action" disabled={draft.uiScale === 100} onClick={() => setDraft({ ...draft, uiScale: 100 })} type="button">{t("settings.reset")}</button>
            </div>
            <div className="form-footnote">{t("settings.uiScaleHint")}</div>
            <h3>{t("settings.workspace")}</h3>
            <label className="field-label" htmlFor="server-open-click">{t("settings.serverOpenClick")}</label>
            <select id="server-open-click" onChange={(event) => setDraft({ ...draft, serverOpenClick: event.target.value as ClickMode })} value={draft.serverOpenClick}>
              <option value="single">{t("settings.clickSingle")}</option>
              <option value="double">{t("settings.clickDouble")}</option>
            </select>
            <label className="field-label" htmlFor="snippet-insert-click">{t("settings.snippetInsertClick")}</label>
            <select id="snippet-insert-click" onChange={(event) => setDraft({ ...draft, snippetInsertClick: event.target.value as ClickMode })} value={draft.snippetInsertClick}>
              <option value="single">{t("settings.clickSingle")}</option>
              <option value="double">{t("settings.clickDouble")}</option>
            </select>
            <label className="field-label" htmlFor="restore-tabs">{t("settings.startup")}</label>
            <select id="restore-tabs" onChange={(event) => setDraft({ ...draft, restoreTabs: event.target.value === "restore" })} value={draft.restoreTabs ? "restore" : "empty"}>
              <option value="empty">{t("settings.startupEmpty")}</option>
              <option value="restore">{t("settings.startupRestore")}</option>
            </select>
            <div className="form-footnote">{t("settings.startupHint")}</div>
            <label className="sidebar-setting">
              <input checked={draft.confirmClose} onChange={(event) => setDraft({ ...draft, confirmClose: event.target.checked })} type="checkbox" />
              <span>{t("settings.confirmClose")}</span>
            </label>
            <div className="form-footnote">{t("settings.confirmCloseHint")}</div>
            <h3>{t("settings.clipboard")}</h3>
            <label className="sidebar-setting">
              <input checked={draft.copyOnSelect} onChange={(event) => setDraft({ ...draft, copyOnSelect: event.target.checked })} type="checkbox" />
              <span>{t("settings.copyOnSelect")}</span>
            </label>
            <label className="sidebar-setting">
              <input checked={draft.confirmMultilinePaste} onChange={(event) => setDraft({ ...draft, confirmMultilinePaste: event.target.checked })} type="checkbox" />
              <span>{t("settings.confirmPaste")}</span>
            </label>
            <label className="sidebar-setting">
              <input checked={draft.allowClipboardWrite} onChange={(event) => setDraft({ ...draft, allowClipboardWrite: event.target.checked })} type="checkbox" />
              <span>{t("settings.allowClipboardWrite")}</span>
            </label>
            <div className="form-footnote">{t("settings.allowClipboardWriteHint")}</div>
            <label className="field-label" htmlFor="clipboard-read">{t("settings.clipboardRead")}</label>
            <select id="clipboard-read" onChange={(event) => setDraft({ ...draft, clipboardRead: event.target.value as ClipboardReadMode })} value={draft.clipboardRead}>
              <option value="ask">{t("settings.clipboardReadAsk")}</option>
              <option value="always">{t("settings.clipboardReadAlways")}</option>
              <option value="never">{t("settings.clipboardReadNever")}</option>
            </select>
            <div className="form-footnote">{t("settings.clipboardReadHint")}</div>
            <label className="sidebar-setting">
              <input checked={draft.forceMouseSelection} onChange={(event) => setDraft({ ...draft, forceMouseSelection: event.target.checked })} type="checkbox" />
              <span>{t("settings.forceMouseSelection")}</span>
            </label>
            <div className="form-footnote">{t("settings.forceMouseSelectionHint")}</div>
            <h3>{t("settings.designs")}</h3>
            <label className="field-label" htmlFor="default-appearance">{t("settings.defaultDesign")}</label>
            <select id="default-appearance" onChange={(event) => setDraft({ ...draft, defaultAppearanceId: event.target.value })} value={draft.defaultAppearanceId}>
              {draft.appearances.map((item) => <option key={item.id} value={item.id}>{item.name || t("settings.unnamed")}</option>)}
            </select>
            <label className="field-label" htmlFor="local-appearance">{t("settings.localDesign")}</label>
            <select id="local-appearance" onChange={(event) => setDraft({ ...draft, localAppearanceId: event.target.value })} value={draft.localAppearanceId}>
              <option value="">{t("settings.defaultDesignOption")}</option>
              {draft.appearances.map((item) => <option key={item.id} value={item.id}>{item.name || t("settings.unnamed")}</option>)}
            </select>
            <DesktopIntegration />
          </div>
        ) : section === "shortcuts" ? (
          <ShortcutList keybindings={draft.keybindings} onChange={(keybindings) => setDraft({ ...draft, keybindings })} />
        ) : (
          <div className="settings-panel appearance-layout" role="tabpanel">
            <div className="appearance-list">
              {draft.appearances.map((item) => (
                <button aria-pressed={item.id === selected.id} className="appearance-item" key={item.id} onClick={() => setSelectedId(item.id)} type="button">
                  <span className="appearance-swatch" style={{ background: item.background, color: item.foreground, borderColor: item.tabColor }}>A</span>
                  <span className="appearance-item-name">{item.name || t("settings.unnamed")}</span>
                  {item.id === draft.defaultAppearanceId && <span className="appearance-badge">{t("settings.defaultBadge")}</span>}
                </button>
              ))}
              <button className="button button-secondary" onClick={() => addAppearance(selected, t("settings.copySuffix", { name: selected.name }))} type="button">{t("settings.duplicate")}</button>
              <button className="button button-secondary" onClick={() => addAppearance(draft.appearances[0], t("settings.newDesign"))} type="button">{t("settings.addDesign")}</button>
            </div>

            <div className="appearance-editor">
              <label className="field-label" htmlFor="appearance-name">{t("settings.name")}</label>
              <input autoComplete="off" id="appearance-name" maxLength={64} onChange={(event) => updateAppearance({ name: event.target.value })} value={selected.name} />

              <div className="color-grid">
                {colorFields.map((field) => (
                  <ColorField key={field.key} label={t(field.label)} onChange={(value) => updateAppearance({ [field.key]: value })} value={selected[field.key]} />
                ))}
              </div>

              <label className="field-label" htmlFor="appearance-font-size">{t("settings.fontSize")} <span>{selected.fontSize} px</span></label>
              <input className="range-input" id="appearance-font-size" max={MAX_FONT_SIZE} min={MIN_FONT_SIZE} onChange={(event) => updateAppearance({ fontSize: Number(event.target.value) })} type="range" value={selected.fontSize} />

              <div className="appearance-preview" style={{ background: selected.background, color: selected.foreground, fontSize: `${selected.fontSize}px`, borderTopColor: selected.tabColor }}>
                <div>admin@server:~$ ls -la</div>
                <div><span style={{ background: `${selected.selection}88` }}>{t("settings.previewSelected")}</span> {t("settings.previewNormal")}</div>
                <div>admin@server:~$ <span className="appearance-preview-cursor" style={{ background: selected.cursor }} /></div>
              </div>

              <div className="form-footnote">
                {usedBy.length === 0 ? t("settings.unused") : t("settings.usedBy", { names: usedBy.join(", ") })}
                {" "}{t("settings.assignHint")}
              </div>
              {selected.id !== DEFAULT_APPEARANCE_ID && (
                <button className="text-action text-danger" onClick={removeAppearance} type="button">{t("settings.deleteDesign")}</button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

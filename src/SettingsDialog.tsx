import { useState } from "react";
import { DEFAULT_APPEARANCE_ID, MAX_FONT_SIZE, MIN_FONT_SIZE } from "./appearance";
import type { AppSettings, Appearance, SavedHost, ThemeMode } from "./terminalTypes";
import { themeModeCycle, themeModeLabels, UI_SCALE_MAX, UI_SCALE_MIN } from "./uiTheme";

type SettingsDialogProps = {
  settings: AppSettings;
  servers: SavedHost[];
  initialAppearanceId?: string;
  onSave: (settings: AppSettings) => Promise<void>;
  onClose: () => void;
};

type Section = "general" | "appearances";

const colorFields: { key: keyof Pick<Appearance, "foreground" | "background" | "cursor" | "selection" | "tabColor">; label: string }[] = [
  { key: "foreground", label: "Schriftfarbe" },
  { key: "background", label: "Hintergrund" },
  { key: "cursor", label: "Cursor" },
  { key: "selection", label: "Markierung" },
  { key: "tabColor", label: "Tab-Farbe" },
];

export default function SettingsDialog({ settings, servers, initialAppearanceId, onSave, onClose }: SettingsDialogProps) {
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
    }));
    setSelectedId(DEFAULT_APPEARANCE_ID);
  }

  async function save() {
    if (nameInvalid) {
      setError("Jedes Design braucht einen Namen.");
      return;
    }
    setSaving(true);
    try {
      await onSave({
        ...draft,
        appearances: draft.appearances.map((item) => ({ ...item, name: item.name.trim() })),
      });
    } catch (saveError) {
      setError(`Einstellungen konnten nicht gespeichert werden: ${String(saveError)}`);
      setSaving(false);
    }
  }

  const usedBy = servers.filter((server) =>
    server.appearanceId ? server.appearanceId === selected.id : selected.id === draft.defaultAppearanceId,
  );

  return (
    <div className="dialog-scrim" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
      <section aria-labelledby="settings-title" aria-modal="true" className="server-dialog settings-dialog" role="dialog">
        <header className="dialog-heading">
          <div><div className="page-eyebrow">CRABSHELL</div><h2 id="settings-title">Einstellungen</h2></div>
          <button aria-label="Einstellungen schließen" className="icon-button" onClick={onClose} type="button">×</button>
        </header>

        <div aria-label="Einstellungsbereiche" className="settings-sections" role="tablist">
          <button aria-selected={section === "general"} autoFocus className="settings-section-tab" onClick={() => setSection("general")} role="tab" type="button">Allgemein</button>
          <button aria-selected={section === "appearances"} className="settings-section-tab" onClick={() => setSection("appearances")} role="tab" type="button">Designs</button>
        </div>

        {section === "general" ? (
          <div className="settings-panel" role="tabpanel">
            <h3>Darstellung</h3>
            <label className="field-label" htmlFor="theme-mode">Farbschema</label>
            <select id="theme-mode" onChange={(event) => setDraft({ ...draft, themeMode: event.target.value as ThemeMode })} value={draft.themeMode}>
              {themeModeCycle.map((mode) => <option key={mode} value={mode}>{themeModeLabels[mode]}</option>)}
            </select>
            <label className="field-label" htmlFor="ui-scale">Textgröße der Oberfläche <span>{draft.uiScale} %</span></label>
            <div className="range-row">
              <input className="range-input" id="ui-scale" max={UI_SCALE_MAX} min={UI_SCALE_MIN} onChange={(event) => setDraft({ ...draft, uiScale: Number(event.target.value) })} step={5} type="range" value={draft.uiScale} />
              <button className="text-action" disabled={draft.uiScale === 100} onClick={() => setDraft({ ...draft, uiScale: 100 })} type="button">Zurücksetzen</button>
            </div>
            <div className="form-footnote">Betrifft Seitenleiste, Tabs, Leisten und Dialoge. Die Schriftgröße im Terminal wird pro Design eingestellt.</div>
            <h3>Zwischenablage</h3>
            <label className="sidebar-setting">
              <input checked={draft.copyOnSelect} onChange={(event) => setDraft({ ...draft, copyOnSelect: event.target.checked })} type="checkbox" />
              <span>Beim Markieren kopieren</span>
            </label>
            <label className="sidebar-setting">
              <input checked={draft.confirmMultilinePaste} onChange={(event) => setDraft({ ...draft, confirmMultilinePaste: event.target.checked })} type="checkbox" />
              <span>Mehrzeiliges Einfügen bestätigen</span>
            </label>
            <h3>Standard-Design</h3>
            <label className="field-label" htmlFor="default-appearance">Für Server ohne eigenes Design und neue Tabs</label>
            <select id="default-appearance" onChange={(event) => setDraft({ ...draft, defaultAppearanceId: event.target.value })} value={draft.defaultAppearanceId}>
              {draft.appearances.map((item) => <option key={item.id} value={item.id}>{item.name || "Ohne Namen"}</option>)}
            </select>
          </div>
        ) : (
          <div className="settings-panel appearance-layout" role="tabpanel">
            <div className="appearance-list">
              {draft.appearances.map((item) => (
                <button aria-pressed={item.id === selected.id} className="appearance-item" key={item.id} onClick={() => setSelectedId(item.id)} type="button">
                  <span className="appearance-swatch" style={{ background: item.background, color: item.foreground, borderColor: item.tabColor }}>A</span>
                  <span className="appearance-item-name">{item.name || "Ohne Namen"}</span>
                  {item.id === draft.defaultAppearanceId && <span className="appearance-badge">Standard</span>}
                </button>
              ))}
              <button className="button button-secondary" onClick={() => addAppearance(selected, `${selected.name} Kopie`)} type="button">Duplizieren</button>
              <button className="button button-secondary" onClick={() => addAppearance(draft.appearances[0], "Neues Design")} type="button">+ Neues Design</button>
            </div>

            <div className="appearance-editor">
              <label className="field-label" htmlFor="appearance-name">Name</label>
              <input autoComplete="off" id="appearance-name" maxLength={64} onChange={(event) => updateAppearance({ name: event.target.value })} value={selected.name} />

              <div className="color-grid">
                {colorFields.map((field) => (
                  <label className="color-field" key={field.key}>
                    <input onChange={(event) => updateAppearance({ [field.key]: event.target.value })} type="color" value={selected[field.key]} />
                    <span>{field.label}</span>
                    <code>{selected[field.key]}</code>
                  </label>
                ))}
              </div>

              <label className="field-label" htmlFor="appearance-font-size">Schriftgröße <span>{selected.fontSize} px</span></label>
              <input className="range-input" id="appearance-font-size" max={MAX_FONT_SIZE} min={MIN_FONT_SIZE} onChange={(event) => updateAppearance({ fontSize: Number(event.target.value) })} type="range" value={selected.fontSize} />

              <div className="appearance-preview" style={{ background: selected.background, color: selected.foreground, fontSize: `${selected.fontSize}px`, borderTopColor: selected.tabColor }}>
                <div>admin@server:~$ ls -la</div>
                <div><span style={{ background: `${selected.selection}88` }}>markierter Text</span> normaler Text</div>
                <div>admin@server:~$ <span className="appearance-preview-cursor" style={{ background: selected.cursor }} /></div>
              </div>

              <div className="form-footnote">
                {usedBy.length === 0 ? "Von keinem Server verwendet." : `Verwendet von: ${usedBy.map((server) => server.label || server.host).join(", ")}`}
                {" "}Das Design wird im Server-Dialog pro Profil zugewiesen.
              </div>
              {selected.id !== DEFAULT_APPEARANCE_ID && (
                <button className="text-action text-danger" onClick={removeAppearance} type="button">Design löschen</button>
              )}
            </div>
          </div>
        )}

        {error && <div aria-live="polite" className="editor-notice">{error}</div>}
        <div className="editor-actions">
          <button className="button button-secondary" onClick={onClose} type="button">Abbrechen</button>
          <button className="button button-primary" disabled={saving} onClick={() => void save()} type="button">Speichern</button>
        </div>
      </section>
    </div>
  );
}

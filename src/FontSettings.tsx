import { useEffect, useState } from "react";
import { DEFAULT_TERMINAL_FONT, DEFAULT_UI_FONT, fontStack, listSystemFonts, type FontFamily } from "./fonts";
import { t, translateBackend } from "./i18n";

type FontSettingsProps = {
  uiFont: string;
  terminalFont: string;
  onChange: (fonts: { uiFont: string; terminalFont: string }) => void;
};

/** Settings → General → Fonts: interface font and terminal font, each with a preview. */
export default function FontSettings({ uiFont, terminalFont, onChange }: FontSettingsProps) {
  const [fonts, setFonts] = useState<FontFamily[] | null>(null);
  const [error, setError] = useState("");
  const [allForTerminal, setAllForTerminal] = useState(false);

  useEffect(() => {
    let mounted = true;
    listSystemFonts()
      .then((list) => { if (mounted) setFonts(list); })
      .catch((loadError: unknown) => { if (mounted) setError(t("settings.fontsFailed", { error: translateBackend(loadError) })); });
    return () => {
      mounted = false;
    };
  }, []);

  const terminalChoices = (fonts ?? []).filter((font) => allForTerminal || font.monospace);

  /** Options for a select; a saved font that is not installed (any more) stays selectable. */
  function options(list: FontFamily[], current: string) {
    const names = list.map((font) => font.name);
    if (current && !names.includes(current)) names.unshift(current);
    return names.map((name) => (
      <option key={name} value={name}>{list.some((font) => font.name === name) ? name : t("settings.fontMissing", { name })}</option>
    ));
  }

  return (
    <>
      <h3>{t("settings.fonts")}</h3>
      {error && <div aria-live="polite" className="editor-notice">{error}</div>}

      <label className="field-label" htmlFor="ui-font">{t("settings.uiFont")}</label>
      <select disabled={!fonts} id="ui-font" onChange={(event) => onChange({ uiFont: event.target.value, terminalFont })} value={uiFont}>
        <option value="">{fonts ? t("settings.fontDefault", { name: t("settings.fontSystem") }) : t("settings.fontsLoading")}</option>
        {options(fonts ?? [], uiFont)}
      </select>
      <div className="font-preview" style={{ fontFamily: fontStack(uiFont, DEFAULT_UI_FONT) }}>{t("settings.uiFontPreview")}</div>

      <label className="field-label" htmlFor="terminal-font">{t("settings.terminalFont")}</label>
      <select disabled={!fonts} id="terminal-font" onChange={(event) => onChange({ uiFont, terminalFont: event.target.value })} value={terminalFont}>
        <option value="">{fonts ? t("settings.fontDefault", { name: "JetBrains Mono" }) : t("settings.fontsLoading")}</option>
        {options(terminalChoices, terminalFont)}
      </select>
      <label className="sidebar-setting">
        <input checked={allForTerminal} onChange={(event) => setAllForTerminal(event.target.checked)} type="checkbox" />
        <span>{t("settings.fontShowAll")}</span>
      </label>
      <div className="font-preview font-preview-terminal" style={{ fontFamily: fontStack(terminalFont, DEFAULT_TERMINAL_FONT) }}>
        admin@server:~$ ls -la  {"{ } [ ] | 0O 1lI"}
      </div>
      <div className="form-footnote">{t("settings.fontsHint")}</div>
    </>
  );
}

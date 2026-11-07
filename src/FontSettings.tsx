import { useEffect, useState } from "react";
import { DEFAULT_TERMINAL_FONT, DEFAULT_UI_FONT, fontStack, listSystemFonts, type FontFamily } from "./fonts";
import { t, translateBackend } from "./i18n";

type FontSettingsProps = {
  /** "ui": interface font (Settings → Display), "terminal": terminal font (Settings → Terminal). */
  part: "ui" | "terminal";
  value: string;
  onChange: (font: string) => void;
};

/** One font choice with a preview: the interface font or the terminal font. */
export default function FontSettings({ part, value, onChange }: FontSettingsProps) {
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

  /** Options for a select; a saved font that is not installed (any more) stays selectable. */
  function options(list: FontFamily[], current: string) {
    const names = list.map((font) => font.name);
    if (current && !names.includes(current)) names.unshift(current);
    return names.map((name) => (
      <option key={name} value={name}>{list.some((font) => font.name === name) ? name : t("settings.fontMissing", { name })}</option>
    ));
  }

  const notice = error && <div aria-live="polite" className="editor-notice">{error}</div>;

  if (part === "ui") {
    return (
      <>
        <label className="field-label" htmlFor="ui-font">{t("settings.uiFont")}</label>
        <select disabled={!fonts} id="ui-font" onChange={(event) => onChange(event.target.value)} value={value}>
          <option value="">{fonts ? t("settings.fontDefault", { name: t("settings.fontSystem") }) : t("settings.fontsLoading")}</option>
          {options(fonts ?? [], value)}
        </select>
        {notice}
        <div className="font-preview" style={{ fontFamily: fontStack(value, DEFAULT_UI_FONT) }}>{t("settings.uiFontPreview")}</div>
      </>
    );
  }

  const terminalChoices = (fonts ?? []).filter((font) => allForTerminal || font.monospace);
  return (
    <>
      <label className="field-label" htmlFor="terminal-font">{t("settings.terminalFont")}</label>
      <select disabled={!fonts} id="terminal-font" onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">{fonts ? t("settings.fontDefault", { name: "JetBrains Mono" }) : t("settings.fontsLoading")}</option>
        {options(terminalChoices, value)}
      </select>
      {notice}
      <label className="sidebar-setting">
        <input checked={allForTerminal} onChange={(event) => setAllForTerminal(event.target.checked)} type="checkbox" />
        <span>{t("settings.fontShowAll")}</span>
      </label>
      <div className="font-preview font-preview-terminal" style={{ fontFamily: fontStack(value, DEFAULT_TERMINAL_FONT) }}>
        admin@server:~$ ls -la  {"{ } [ ] | 0O 1lI"}
      </div>
      <div className="form-footnote">{t("settings.fontsHint")}</div>
    </>
  );
}

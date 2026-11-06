import { useEffect, useRef } from "react";
import { t } from "./i18n";
import { MAX_TAB_TITLE_CHARS } from "./terminalStore";

type TabRenameFieldProps = {
  /** Current custom name ("" = automatic). */
  value: string;
  /** Shown when the field is empty: the automatic title. */
  placeholder: string;
  /** New name (may be "" for automatic), or null when cancelled. */
  onDone: (title: string | null) => void;
};

/** Inline name field in the tab strip. Enter or leaving the field saves, Escape cancels. */
export default function TabRenameField({ value, placeholder, onDone }: TabRenameFieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (title: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(title);
  };

  return (
    <input
      aria-label={t("tabs.renameLabel")}
      autoComplete="off"
      className="terminal-tab-rename"
      defaultValue={value}
      maxLength={MAX_TAB_TITLE_CHARS}
      onBlur={(event) => finish(event.currentTarget.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(event.currentTarget.value);
        else if (event.key === "Escape") finish(null);
      }}
      placeholder={placeholder}
      ref={ref}
      spellCheck={false}
      title={t("tabs.renameLabel")}
    />
  );
}

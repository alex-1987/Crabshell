import { useEffect, useState } from "react";
import { t, type MessageKey } from "./i18n";
import {
  actionForCombo,
  checkCombo,
  comboFromEvent,
  DEFAULT_KEYBINDINGS,
  displayCombo,
  KEY_ACTIONS,
  MAX_BINDINGS_PER_ACTION,
  resolveKeybindings,
  type KeyAction,
  type Keybindings,
} from "./keybindings";

/** `keys` are keyboard keys; `gesture` describes a mouse action instead. */
type FixedShortcut = { keys?: string[]; gesture?: MessageKey; label: MessageKey };
type FixedGroup = { title: MessageKey; items: FixedShortcut[] };

/** Shortcuts outside the terminal; they cannot be changed. */
const fixedGroups: FixedGroup[] = [
  {
    title: "keys.groupMouse",
    items: [
      { gesture: "keys.gestureRightClick", label: "keys.rightClick" },
      { gesture: "keys.gestureMiddleClick", label: "keys.middleClick" },
      { gesture: "keys.gestureShiftDrag", label: "keys.shiftDrag" },
      { gesture: "keys.gestureDragTab", label: "keys.dragTab" },
      { keys: ["Esc"], label: "keys.cancelDrag" },
      { gesture: "keys.gestureDoubleClickDivider", label: "keys.dividerDouble" },
    ],
  },
  {
    title: "keys.groupSnippets",
    items: [
      { keys: ["↑", "↓"], label: "keys.pickerSelect" },
      { keys: ["Enter"], label: "keys.pickerInsert" },
      { keys: ["Ctrl+Enter"], label: "keys.pickerRun" },
      { keys: ["Esc"], label: "keys.pickerClose" },
    ],
  },
  {
    title: "keys.groupGeneral",
    items: [
      { keys: ["Esc"], label: "keys.escape" },
      { keys: ["Esc"], label: "keys.clearSearch" },
      { keys: ["←", "→", "↑", "↓"], label: "keys.dividerKeys" },
      { keys: ["←", "→"], label: "keys.sidebarResize" },
    ],
  },
];

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Stores only actions that differ from the defaults. */
function toCustom(resolved: Record<KeyAction, string[]>): Keybindings {
  const custom: Keybindings = {};
  for (const { action } of KEY_ACTIONS) {
    if (!sameList(resolved[action], DEFAULT_KEYBINDINGS[action])) custom[action] = resolved[action];
  }
  return custom;
}

type ShortcutListProps = {
  keybindings: Keybindings;
  onChange: (keybindings: Keybindings) => void;
};

/** Settings → Shortcuts: terminal shortcuts can be rebound, the rest is listed for reference. */
export default function ShortcutList({ keybindings, onChange }: ShortcutListProps) {
  const resolved = resolveKeybindings(keybindings);
  const [recording, setRecording] = useState<KeyAction | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: "info" | "warning" | "error" } | null>(null);
  const labelOf = (action: KeyAction) => t(KEY_ACTIONS.find((item) => item.action === action)?.label ?? "keys.copy");

  function update(next: Record<KeyAction, string[]>) {
    onChange(toCustom(next));
  }

  // While recording, every key press goes here (and not to the dialog, so Esc does not close it).
  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
        setRecording(null);
        setMessage(null);
        return;
      }
      const combo = comboFromEvent(event);
      if (!combo) return;
      const check = checkCombo(combo);
      if (check === "needsModifier") {
        setMessage({ text: t("keys.needsModifier", { combo: displayCombo(combo) }), kind: "error" });
        return;
      }
      const next = { ...resolved };
      const conflict = actionForCombo(resolved, combo, recording);
      if (conflict) next[conflict] = next[conflict].filter((item) => item !== combo);
      if (!next[recording].includes(combo)) next[recording] = [...next[recording], combo].slice(-MAX_BINDINGS_PER_ACTION);
      update(next);
      setRecording(null);
      if (conflict) setMessage({ text: t("keys.movedFrom", { combo: displayCombo(combo), action: labelOf(conflict) }), kind: "warning" });
      else if (check === "terminalControl") setMessage({ text: t("keys.terminalControl", { combo: displayCombo(combo) }), kind: "warning" });
      else setMessage({ text: t("keys.assigned", { combo: displayCombo(combo), action: labelOf(recording) }), kind: "info" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const customized = Object.keys(toCustom(resolved)).length > 0;

  return (
    <div className="settings-panel shortcut-list" role="tabpanel">
      <section aria-label={t("keys.groupCustom")} className="shortcut-group">
        <h3>{t("keys.groupCustom")}</h3>
        <div className="form-footnote">{t("keys.customHint")}</div>
        <dl>
          {KEY_ACTIONS.map(({ action, label }) => {
            const combos = resolved[action];
            const isDefault = sameList(combos, DEFAULT_KEYBINDINGS[action]);
            return (
              <div className="shortcut-row" key={action}>
                <dt>{t(label)}</dt>
                <dd>
                  {combos.length === 0 && recording !== action && <span className="shortcut-mouse">{t("keys.none")}</span>}
                  {combos.map((combo) => (
                    <span className="shortcut-chip" key={combo}>
                      <kbd>{displayCombo(combo)}</kbd>
                      <button aria-label={t("keys.remove", { combo: displayCombo(combo), action: t(label) })} className="shortcut-chip-remove" onClick={() => update({ ...resolved, [action]: combos.filter((item) => item !== combo) })} title={t("keys.removeTitle")} type="button">×</button>
                    </span>
                  ))}
                  {recording === action ? (
                    <button autoFocus className="shortcut-record shortcut-recording" onClick={() => setRecording(null)} type="button">{t("keys.recording")}</button>
                  ) : (
                    <button aria-label={t("keys.add", { action: t(label) })} className="shortcut-record" disabled={combos.length >= MAX_BINDINGS_PER_ACTION} onClick={() => { setMessage(null); setRecording(action); }} title={t("keys.addTitle")} type="button">+</button>
                  )}
                  <button aria-label={t("keys.resetOne", { action: t(label) })} className="shortcut-reset" disabled={isDefault} onClick={() => update({ ...resolved, [action]: DEFAULT_KEYBINDINGS[action] })} title={t("keys.resetOneTitle")} type="button">↺</button>
                </dd>
              </div>
            );
          })}
        </dl>
        {message && <div aria-live="polite" className={`shortcut-message shortcut-message-${message.kind}`}>{message.text}</div>}
        <div className="shortcut-actions">
          <button className="text-action" disabled={!customized} onClick={() => { onChange({}); setMessage({ text: t("keys.resetAllDone"), kind: "info" }); }} type="button">{t("keys.resetAll")}</button>
        </div>
      </section>

      {fixedGroups.map((group) => (
        <section aria-label={t(group.title)} className="shortcut-group" key={group.title}>
          <h3>{t(group.title)}</h3>
          <dl>
            {group.items.map((item) => (
              <div className="shortcut-row" key={item.label}>
                <dt>{t(item.label)}</dt>
                <dd>
                  {item.gesture && <span className="shortcut-mouse">{t(item.gesture)}</span>}
                  {item.keys?.map((key, index) => (
                    <span key={key}>{index > 0 && <span className="shortcut-sep">/</span>}<kbd>{key}</kbd></span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <div className="form-footnote">{t("keys.footnote")}</div>
    </div>
  );
}

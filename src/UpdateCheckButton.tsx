import { getVersion } from "@tauri-apps/api/app";
import { openInBrowser } from "./browser";
import { useState } from "react";
import { t } from "./i18n";
import { checkNow, type CheckResult } from "./updates";

/** Settings → Updates: check right now, also when the automatic check is off. */
export default function UpdateCheckButton() {
  const [state, setState] = useState<{ current: string; result: CheckResult } | "checking" | null>(null);

  const result = state && state !== "checking" ? state.result : null;
  const current = state && state !== "checking" ? state.current : null;

  async function check() {
    setState("checking");
    const current = await getVersion().catch(() => "");
    setState({ current, result: await checkNow(current) });
  }

  return (
    <div className="update-check">
      <button className="button button-secondary" disabled={state === "checking"} onClick={() => void check()} type="button">
        {state === "checking" ? t("update.checking") : t("update.checkNow")}
      </button>
      {result && current !== null && (
        <span aria-live="polite" className="update-check-result">
          {result.kind === "error" && t("update.failed")}
          {result.kind === "current" && t("update.upToDate", { current, latest: result.latest })}
          {result.kind === "newer" && (
            <>
              {t("update.newer", { version: result.update.version, current })}{" "}
              <button className="text-action" onClick={() => void openInBrowser(result.update.url).catch(() => undefined)} type="button">{t("update.openPage")}</button>
            </>
          )}
        </span>
      )}
    </div>
  );
}

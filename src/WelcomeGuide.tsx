import BrandMark from "./BrandMark";
import { t } from "./i18n";
import { terminalStore } from "./terminalStore";

type WelcomeGuideProps = {
  hasServers: boolean;
  doubleClick: boolean;
  onAddServer: () => void;
  onLocalShell: () => void;
  onSnippets: () => void;
  onSettings: () => void;
  onHide: () => void;
};

function Keys({ combo }: { combo: string }) {
  return combo ? <kbd>{combo}</kbd> : null;
}

/** Short getting-started guide in the empty terminal area (shown while no tab is open). */
export default function WelcomeGuide({ hasServers, doubleClick, onAddServer, onLocalShell, onSnippets, onSettings, onHide }: WelcomeGuideProps) {
  const key = (action: Parameters<typeof terminalStore.shortcutLabel>[0]) => terminalStore.shortcutLabel(action);
  return (
    <div className="welcome">
      <div className="welcome-head">
        <BrandMark size={66} />
        <div>
          <h2>{t("welcome.title")}</h2>
          <p>{t("welcome.subtitle")}</p>
        </div>
      </div>

      <ol className="welcome-steps">
        <li className={hasServers ? "welcome-step-done" : ""}>
          <div className="welcome-step-text">
            <strong>{t("welcome.addTitle")}</strong>
            <span>{t("welcome.addText")}</span>
          </div>
          <button className="button button-primary welcome-action" onClick={onAddServer} type="button">{t("welcome.addButton")}</button>
        </li>
        <li>
          <div className="welcome-step-text">
            <strong>{t("welcome.connectTitle")}</strong>
            <span>{doubleClick ? t("welcome.connectTextDouble") : t("welcome.connectText")} {t("welcome.hostKey")}</span>
          </div>
        </li>
        <li>
          <div className="welcome-step-text">
            <strong>{t("welcome.localTitle")}</strong>
            <span>{t("welcome.localText")} <Keys combo={key("localShell")} /></span>
          </div>
          <button className="button button-secondary welcome-action" onClick={onLocalShell} type="button">{t("welcome.localButton")}</button>
        </li>
        <li>
          <div className="welcome-step-text">
            <strong>{t("welcome.splitTitle")}</strong>
            <span>{t("welcome.splitText")} <Keys combo={key("splitRight")} /> <Keys combo={key("splitDown")} /></span>
          </div>
        </li>
        <li>
          <div className="welcome-step-text">
            <strong>{t("welcome.snippetsTitle")}</strong>
            <span>{t("welcome.snippetsText")} <Keys combo={key("snippets")} /></span>
          </div>
          <button className="button button-secondary welcome-action" onClick={onSnippets} type="button">{t("welcome.snippetsButton")}</button>
        </li>
        <li>
          <div className="welcome-step-text">
            <strong>{t("welcome.clipboardTitle")}</strong>
            <span>{t("welcome.clipboardText")} <Keys combo={key("copy")} /> <Keys combo={key("paste")} /></span>
          </div>
        </li>
        <li>
          <div className="welcome-step-text">
            <strong>{t("welcome.settingsTitle")}</strong>
            <span>{t("welcome.settingsText")}</span>
          </div>
          <button className="button button-secondary welcome-action" onClick={onSettings} type="button">{t("welcome.settingsButton")}</button>
        </li>
      </ol>

      <div className="welcome-foot">
        <span>{t("welcome.privacy")}</span>
        <button className="text-action" onClick={onHide} type="button">{t("welcome.hide")}</button>
      </div>
    </div>
  );
}

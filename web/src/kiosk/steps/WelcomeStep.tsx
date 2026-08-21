import { LANG_OPTIONS, LANG_NATIVE_NAMES, useKioskLang } from "../i18n";
import VoiceGuidanceToggle from "../VoiceGuidanceToggle";

export default function WelcomeStep({ stationName, onNext }: { stationName: string; onNext: () => void }) {
  const { t, lang, setLang } = useKioskLang();

  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ position: "absolute", top: "1.25rem", left: "1.25rem" }}>
        <VoiceGuidanceToggle />
      </div>
      <h1 style={{ fontSize: "2.2rem", margin: "0 0 0.4rem" }}>{t("welcome.title")}</h1>
      <p className="hint-text" style={{ fontSize: "1.1rem", marginBottom: "2rem" }}>{stationName}</p>

      <p className="hint-text">{t("welcome.chooseLanguage")}</p>
      <div className="option-grid">
        {LANG_OPTIONS.map((opt) => (
          <button
            key={opt.code}
            type="button"
            className={`option-btn ${lang === opt.code ? "selected" : ""}`}
            onClick={() => setLang(opt.code)}
          >
            {LANG_NATIVE_NAMES[opt.code]}
          </button>
        ))}
      </div>

      <div className="kiosk-actions" style={{ justifyContent: "center" }}>
        <button className="primary" style={{ minWidth: 220 }} onClick={onNext}>
          {t("plate.continue")}
        </button>
      </div>
    </div>
  );
}

import { useState } from "react";
import { useKioskLang } from "./i18n";
import { isVoiceGuidanceEnabled, setVoiceGuidanceEnabled, speak } from "./voiceGuidance";

export default function VoiceGuidanceToggle() {
  const { t, locale } = useKioskLang();
  const [enabled, setEnabled] = useState(isVoiceGuidanceEnabled);

  function toggle() {
    const next = !enabled;
    setVoiceGuidanceEnabled(next);
    setEnabled(next);
    if (next) speak(t("voice.enabledAnnouncement"), locale);
  }

  return (
    <button
      type="button"
      className={enabled ? "active" : ""}
      onClick={toggle}
      title={t(enabled ? "voice.toggleOffLabel" : "voice.toggleOnLabel")}
      aria-pressed={enabled}
      style={{ padding: "0.3rem 0.6rem", fontSize: "0.8rem" }}
    >
      {enabled ? "🔊" : "🔇"}
    </button>
  );
}

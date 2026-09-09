import { useState } from "react";
import { kioskApi } from "./kioskApi";
import { getKioskDeviceToken } from "./kioskDeviceToken";
import { useIntercomCall } from "../shared/useIntercomCall";
import { useKioskLang } from "./i18n";

/**
 * Musteri -> gorevli iki yonlu sesli interkom (TS 12820 madde 4.9.3.5): gorevli,
 * dagitim birimi bolgesindeki musteriyle daima iletisim kurabilmelidir. Personelsiz/
 * uzak izlenen bir istasyonda musteri butona basar basmaz personelin ekraninda/
 * telefonunda canli bir cagri bildirimi belirir (bkz. useIncomingIntercomCalls.ts)
 * ve WebRTC ile dogrudan sesli gorusme baslar.
 */
export default function IntercomCall({ pumpId }: { pumpId?: number | null }) {
  const { t } = useKioskLang();
  const [open, setOpen] = useState(false);
  const [signalingTopic, setSignalingTopic] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startFailed, setStartFailed] = useState(false);

  const { status, remoteAudioRef, hangUp } = useIntercomCall({
    topic: signalingTopic,
    accessToken: getKioskDeviceToken() ?? undefined,
    isCaller: true,
  });

  function reset() {
    setOpen(false);
    setSignalingTopic(null);
    setStartFailed(false);
  }

  async function startCall() {
    setStarting(true);
    setStartFailed(false);
    try {
      const res = await kioskApi.ringIntercom(pumpId ?? undefined);
      setSignalingTopic(res.signalingTopic);
    } catch {
      setStartFailed(true);
    } finally {
      setStarting(false);
    }
  }

  function statusLabel(): string {
    switch (status) {
      case "ringing":
        return t("intercom.ringing");
      case "connecting":
        return t("intercom.connecting");
      case "connected":
        return t("intercom.connected");
      case "ended":
        return t("intercom.ended");
      case "mic-denied":
        return t("intercom.micDenied");
      case "error":
        return t("intercom.error");
      case "timeout":
        return t("intercom.noAnswer");
      default:
        return t("intercom.connecting");
    }
  }

  return (
    <>
      <button type="button" className="kiosk-privacy-link" onClick={() => setOpen(true)}>
        {t("intercom.linkLabel")}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 20,
          }}
          onClick={signalingTopic ? undefined : reset}
        >
          <div
            className="kiosk-card"
            style={{ width: "min(480px, 92vw)", textAlign: "center" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>{t("intercom.title")}</h3>

            {!signalingTopic ? (
              <>
                <p className="hint-text">{t("intercom.intro")}</p>
                <p className="hint-text">{t("intercom.micPrompt")}</p>
                {startFailed && <p className="error-text">{t("intercom.error")}</p>}
                <div className="kiosk-actions">
                  <button type="button" onClick={reset}>
                    {t("intercom.cancel")}
                  </button>
                  <button type="button" className="primary" onClick={startCall} disabled={starting}>
                    {t("intercom.start")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className={status === "error" || status === "mic-denied" || status === "timeout" ? "error-text" : "hint-text"} style={{ fontSize: "1.1rem", margin: "1.5rem 0" }}>
                  {statusLabel()}
                </p>
                <audio ref={remoteAudioRef} autoPlay />
                <div className="kiosk-actions">
                  <span />
                  {status === "ended" || status === "error" || status === "mic-denied" || status === "timeout" ? (
                    <button type="button" className="primary" onClick={reset}>
                      {t("intercom.close")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        hangUp();
                        reset();
                      }}
                    >
                      {t("intercom.hangUp")}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

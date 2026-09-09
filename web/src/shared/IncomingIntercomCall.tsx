import { useState } from "react";
import { useTopicSubscription } from "./useWebSocket";
import { useEffectiveStationId } from "./useEffectiveStation";
import { useIntercomCall, type IntercomCallStatus } from "./useIntercomCall";

interface IncomingCall {
  kioskId: number;
  kioskLabel: string;
  pumpId: number | null;
  callId: string;
  signalingTopic: string;
  startedAt: string;
}

const STATUS_LABEL: Record<IntercomCallStatus, string> = {
  connecting: "Bağlanıyor...",
  ringing: "Çağrılıyor...",
  connected: "Bağlandı — konuşabilirsiniz",
  ended: "Görüşme sona erdi",
  error: "Görüşme kurulamadı.",
  "mic-denied": "Mikrofon erişimi reddedildi. Tarayıcı ayarlarından mikrofona izin verin.",
  timeout: "Müşteri görüşmeyi kapattı.",
};

/**
 * Gelen interkom cagrisi bildirimi (TS 12820 madde 4.9.3.5): gorevli, dagitim birimi
 * bolgesindeki musteriyle daima iletisim kurabilmelidir. Kiosk'tan gelen her cagri
 * ("intercom-calls:<stationId>" topic'i, bkz. routes/kiosk.ts POST /intercom/ring)
 * hangi sayfada olursa olsun bu bilesen sayesinde operatore/admin'e gorunur - kritik
 * alarm bildirimiyle (useCriticalAlarmNotifications) AYNI yerde (AppLayout) monte edilir.
 *
 * BILINEN SINIRLAMA: musteri "Yanitla"ya basilmadan (ör. ekrandan uzaklasip zaman
 * asimina ugrayarak) cagriyi birakirsa, operator henuz sinyallesme kanalina abone
 * OLMADIGI icin kiosk'un gonderdigi "hangup" sinyalini almaz ve bu bildirim
 * operator elle "Reddet"e basana kadar acik kalir - kabul edilebilir bir MVP
 * sinirlamasi (yanlislikla acik kalan bildirim, kacan gercek bir cagridan iyidir).
 */
export default function IncomingIntercomCall() {
  const stationId = useEffectiveStationId();
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [activeTopic, setActiveTopic] = useState<string | null>(null);

  useTopicSubscription(stationId !== null ? `intercom-calls:${stationId}` : null, (payload) => {
    setIncoming(payload as IncomingCall);
  });

  const { status, remoteAudioRef, hangUp } = useIntercomCall({ topic: activeTopic, isCaller: false });

  if (!incoming) return null;

  function decline() {
    setIncoming(null);
  }

  function endCall() {
    hangUp();
    setActiveTopic(null);
    setIncoming(null);
  }

  const answered = activeTopic !== null;
  const finished = answered && (status === "ended" || status === "error" || status === "timeout" || status === "mic-denied");

  return (
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
        zIndex: 100,
      }}
    >
      <div className="card" style={{ width: "min(420px, 92vw)", textAlign: "center" }}>
        <h3>İnterkom Çağrısı</h3>
        <p className="hint-text">
          {incoming.kioskLabel}
          {incoming.pumpId ? ` — Pompa ${incoming.pumpId}` : ""}
        </p>

        {!answered ? (
          <>
            <p style={{ fontSize: "1.1rem", margin: "1.5rem 0" }}>Müşteri sizi arıyor...</p>
            <div className="toolbar" style={{ justifyContent: "center", gap: "0.75rem" }}>
              <button type="button" onClick={decline}>
                Reddet
              </button>
              <button type="button" className="primary" onClick={() => setActiveTopic(incoming.signalingTopic)}>
                Yanıtla
              </button>
            </div>
          </>
        ) : (
          <>
            <p className={status === "error" || status === "mic-denied" ? "error-text" : "hint-text"} style={{ fontSize: "1.1rem", margin: "1.5rem 0" }}>
              {STATUS_LABEL[status]}
            </p>
            <audio ref={remoteAudioRef} autoPlay />
            <div className="toolbar" style={{ justifyContent: "center" }}>
              {finished ? (
                <button type="button" className="primary" onClick={() => setIncoming(null)}>
                  Kapat
                </button>
              ) : (
                <button type="button" className="primary" onClick={endCall}>
                  Görüşmeyi Bitir
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

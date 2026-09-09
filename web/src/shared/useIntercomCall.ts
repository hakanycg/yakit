import { useEffect, useRef, useState } from "react";
import { useRelayChannel } from "./useRelayChannel";

/**
 * Kiosk <-> operator iki yonlu sesli interkom (TS 12820 madde 4.9.3.5): gorevli,
 * dagitim birimi bolgesindeki musteriyle daima iletisim kurabilmelidir.
 *
 * Ses tarayicidan tarayiciya standart bir WebRTC RTCPeerConnection ile dogrudan
 * akar - sunucu yalnizca SDP/ICE sinyallesmesini iletir (bkz. useRelayChannel,
 * ws/hub.ts "relay" mesaj tipi), ses verisini hic gormez. MVP icin yalnizca
 * genel bir STUN sunucusu kullanilir (TURN yok) - kiosk ve operator normalde
 * ayni istasyon LAN'inda ya da STUN ile ulasilabilir oldugundan kabul edilebilir
 * bir risk; TURN gerekiyorsa ileride eklenebilir.
 *
 * Sinyallesme kanalinda "kim once abone oldu" garantisi YOK (basit relay, presence/ack
 * yok): arayan taraf cagriyi baslattiginda karsi taraf henuz topic'e abone olmamis
 * olabilir (operator "Yanitla" butonuna basana kadar abone olmaz). Bu yuzden: (1)
 * arayan, yanit gelene kadar teklifini (offer) periyodik olarak TEKRAR gonderir
 * (gercek bir telefonun calmaya devam etmesi gibi), (2) yanitlayan, henuz kendi
 * baglantisini kurmadan once gelen sinyalleri (erken ICE adaylari) bir kuyrukta
 * biriktirip baglanti hazir olunca isler.
 */

type SignalMessage =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit }
  | { kind: "hangup" };

export type IntercomCallStatus = "connecting" | "ringing" | "connected" | "ended" | "error" | "mic-denied" | "timeout";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const OFFER_RETRY_MS = 1500;
const RING_TIMEOUT_MS = 45_000;

export function useIntercomCall(options: {
  /** Sinyallesme kanali: "intercom:<kioskId>:<callId>". null iken hic baglanti kurulmaz. */
  topic: string | null;
  /** Kiosk tarafinda cihaz tokeni; operator tarafinda gerekmez (oturum cerezi yeter). */
  accessToken?: string;
  /** true: cagriyi baslatan taraf (offer olusturur ve yanit gelene kadar tekrar gonderir). false: cagriyi yanitlayan taraf. */
  isCaller: boolean;
}): {
  status: IntercomCallStatus;
  remoteAudioRef: React.RefObject<HTMLAudioElement>;
  hangUp: () => void;
} {
  const { topic, accessToken, isCaller } = options;
  const [status, setStatus] = useState<IntercomCallStatus>("connecting");
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const hungUpRef = useRef(false);
  const answeredRef = useRef(false);
  const offerHandledRef = useRef(false);
  const pendingRef = useRef<SignalMessage[]>([]);

  const handleSignalRef = useRef<(msg: SignalMessage) => void>(() => {});
  const { send } = useRelayChannel(
    topic,
    (data) => handleSignalRef.current(data as SignalMessage),
    accessToken
  );

  useEffect(() => {
    if (!topic) return;
    hungUpRef.current = false;
    answeredRef.current = false;
    offerHandledRef.current = false;
    pendingRef.current = [];
    let cancelled = false;
    let offerRetryTimer: ReturnType<typeof setInterval> | null = null;
    let ringTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

    function processSignal(pc: RTCPeerConnection, msg: SignalMessage) {
      if (msg.kind === "offer") {
        if (offerHandledRef.current) return;
        offerHandledRef.current = true;
        pc.setRemoteDescription({ type: "offer", sdp: msg.sdp })
          .then(() => pc.createAnswer())
          .then((answer) => pc.setLocalDescription(answer).then(() => answer))
          .then((answer) => send({ kind: "answer", sdp: answer.sdp }))
          .catch(() => setStatus("error"));
      } else if (msg.kind === "answer") {
        if (answeredRef.current) return;
        answeredRef.current = true;
        if (offerRetryTimer) clearInterval(offerRetryTimer);
        if (ringTimeoutTimer) clearTimeout(ringTimeoutTimer);
        pc.setRemoteDescription({ type: "answer", sdp: msg.sdp }).catch(() => setStatus("error"));
      } else if (msg.kind === "ice") {
        pc.addIceCandidate(msg.candidate).catch(() => {
          // ICE aday eklenemedi (baglanti kapanmis olabilir) - sessizce yoksay
        });
      } else if (msg.kind === "hangup") {
        if (offerRetryTimer) clearInterval(offerRetryTimer);
        if (ringTimeoutTimer) clearTimeout(ringTimeoutTimer);
        setStatus("ended");
      }
    }

    handleSignalRef.current = (msg: SignalMessage) => {
      if (hungUpRef.current) return;
      const pc = pcRef.current;
      if (!pc) {
        // Karsi taraf henuz kendi baglantisini kurmadi (ör. "Yanitla" butonuna
        // basmadi) - mesaj kaybolmasin diye biriktirilir, pc hazir olunca islenir.
        pendingRef.current.push(msg);
        return;
      }
      processSignal(pc, msg);
    };

    async function start() {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch {
        if (!cancelled) setStatus("mic-denied");
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      localStreamRef.current = stream;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      pc.ontrack = (event) => {
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = event.streams[0] ?? null;
          void remoteAudioRef.current.play().catch(() => {
            // Otomatik oynatma engellenmis olabilir - kullanici etkilesimiyle devam eder
          });
        }
        setStatus("connected");
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) send({ kind: "ice", candidate: event.candidate.toJSON() });
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") {
          setStatus("error");
        } else if (pc.connectionState === "closed") {
          setStatus((s) => (s === "connected" ? "ended" : s));
        }
      };

      // pc hazir oldu - bu ana kadar biriken sinyalleri (ör. erken gelen ICE adaylari) isle.
      const queued = pendingRef.current;
      pendingRef.current = [];
      queued.forEach((msg) => processSignal(pc, msg));

      if (isCaller) {
        setStatus("ringing");
        try {
          const offer = await pc.createOffer();
          if (cancelled) return;
          await pc.setLocalDescription(offer);
          send({ kind: "offer", sdp: offer.sdp! });
          // Karsi taraf henuz abone olmamis olabilir (basit relay, teslim garantisi
          // yok) - yanit gelene kadar teklifi periyodik tekrar gonder.
          offerRetryTimer = setInterval(() => {
            if (!answeredRef.current) send({ kind: "offer", sdp: offer.sdp! });
          }, OFFER_RETRY_MS);
          ringTimeoutTimer = setTimeout(() => {
            if (!answeredRef.current && !hungUpRef.current) {
              if (offerRetryTimer) clearInterval(offerRetryTimer);
              // Karsi taraf henuz yanitlamadiysa da "hangup" gonderilir - aksi halde
              // operatorun ekranindaki "geliyor cagri" bildirimi sonsuza kadar acik kalirdi.
              send({ kind: "hangup" });
              setStatus("timeout");
              pc.close();
            }
          }, RING_TIMEOUT_MS);
        } catch {
          setStatus("error");
        }
      }
    }

    void start();

    return () => {
      cancelled = true;
      if (offerRetryTimer) clearInterval(offerRetryTimer);
      if (ringTimeoutTimer) clearTimeout(ringTimeoutTimer);
      pcRef.current?.close();
      pcRef.current = null;
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, isCaller]);

  function hangUp() {
    if (hungUpRef.current) return;
    hungUpRef.current = true;
    send({ kind: "hangup" });
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setStatus("ended");
  }

  return { status, remoteAudioRef, hangUp };
}

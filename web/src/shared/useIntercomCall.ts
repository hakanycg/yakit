import { useEffect, useRef, useState } from "react";
import { useRelayChannel } from "./useRelayChannel";
import { api, uploadBinary } from "./api";

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

/**
 * Tarayicilarin otomatik-oynatma (autoplay) politikasi: bir kullanici jesti (tiklama)
 * OLMADAN baslatilan sesli oynatma genellikle reddedilir. "Yanitla"/"Aramayi Baslat"
 * tiklamasi bir jest olsa da, WebRTC muzakeresi (ICE/DTLS) bitip uzak ses parcasi
 * (ontrack) gelene kadar gecen sure boyunca bu jestin geçerliligi (Chrome'un
 * "transient activation" penceresi) suresi dolabilir - bu durumda remoteAudioRef.play()
 * SESSIZCE reddedilir: baglanti "Baglandi" gorunur ama HICBIR SES CALMAZ. Bu, gercek
 * kullanimda bildirilen "interkomdan ses gelmiyor" sorununun kok nedeniydi. Cozum:
 * play() basarisiz olursa bunu disariya (audioBlocked) bildir, UI dogrudan bir
 * tiklamayla (bu TAZE bir kullanici jesti oldugundan kesin basarili olur) tekrar
 * calistirabilecegi bir dugme gostersin.
 */

/**
 * Interkom cagri kaydi (guvenlik amacli - bkz. server/src/services/callRecordingService.ts):
 * SADECE YANITLAYAN tarafta (isCaller=false, her zaman gorevli/operator) alinir - kiosk
 * her zaman ARAYAN taraftir, yani gorevlinin tarayicisi her cagride var olan TEK
 * deterministik/kimligi dogrulanmis uctur. Yerel mikrofon + WebRTC uzak sesi Web Audio
 * API (AudioContext.createMediaStreamDestination) ile TEK bir akista karistirilir,
 * MediaRecorder ile kaydedilir; cagri bitince tek dosya olarak yuklenir.
 *
 * Kayit BEST-EFFORT'tur: tarayici destegi yoksa, sunucu ozelligi kapaliysa (config
 * ucu enabled=false doner) ya da yukleme basarisiz olursa GORUSMENIN KENDISI hic
 * etkilenmez - yalnizca kayit sessizce atlanir.
 */
async function fetchRecordingEnabled(): Promise<boolean> {
  try {
    const res = await api.get<{ enabled: boolean }>("/api/intercom-recordings/config");
    return res.enabled;
  } catch {
    return false;
  }
}


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
  /**
   * Yalnizca isCaller=false (operator) tarafinda, GUVENLIK KAYDI icin kullanilir - bkz.
   * yukaridaki "Interkom cagri kaydi" yorumu. isCaller=true iken yoksayilir.
   */
  callId?: string;
  kioskId?: number | null;
  pumpId?: number | null;
}): {
  status: IntercomCallStatus;
  remoteAudioRef: React.RefObject<HTMLAudioElement>;
  /** true: uzak ses parcasi baglandi ama tarayici otomatik oynatmayi engelledi - kullaniciya "dokunun" dugmesi gosterin. */
  audioBlocked: boolean;
  /** audioBlocked iken, KULLANICI TIKLAMASI icinden cagrilmali (autoplay politikasini asmak icin taze bir jest gerekir). */
  playRemoteAudio: () => void;
  hangUp: () => void;
} {
  const { topic, accessToken, isCaller, callId, kioskId, pumpId } = options;
  const [status, setStatus] = useState<IntercomCallStatus>("connecting");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const hungUpRef = useRef(false);
  const answeredRef = useRef(false);
  const offerHandledRef = useRef(false);
  const pendingRef = useRef<SignalMessage[]>([]);

  // Interkom kaydi (bkz. yukaridaki blok yorumu) - yalnizca isCaller=false icin doldurulur.
  const recordingEnabledRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<BlobPart[]>([]);
  const recordingAudioCtxRef = useRef<AudioContext | null>(null);
  const recordingStartedAtRef = useRef<string | null>(null);
  const callIdRef = useRef(callId);
  const kioskIdRef = useRef(kioskId);
  const pumpIdRef = useRef(pumpId);
  callIdRef.current = callId;
  kioskIdRef.current = kioskId;
  pumpIdRef.current = pumpId;

  useEffect(() => {
    if (isCaller) return;
    let cancelled = false;
    void fetchRecordingEnabled().then((enabled) => {
      if (!cancelled) recordingEnabledRef.current = enabled;
    });
    return () => {
      cancelled = true;
    };
  }, [isCaller]);

  function startRecording(remoteStream: MediaStream) {
    if (isCaller || !recordingEnabledRef.current || mediaRecorderRef.current || !localStreamRef.current) return;
    try {
      const AudioCtx = window.AudioContext;
      const ctx = new AudioCtx();
      const dest = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(localStreamRef.current).connect(dest);
      ctx.createMediaStreamSource(remoteStream).connect(dest);

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(dest.stream, { mimeType });
      recordingChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      recorder.start(1000);
      mediaRecorderRef.current = recorder;
      recordingAudioCtxRef.current = ctx;
      recordingStartedAtRef.current = new Date().toISOString();
    } catch {
      // Web Audio/MediaRecorder desteklenmiyor olabilir - kayit atlanir, gorusme etkilenmez.
    }
  }

  function finishRecording() {
    const recorder = mediaRecorderRef.current;
    const ctx = recordingAudioCtxRef.current;
    const startedAt = recordingStartedAtRef.current;
    const thisCallId = callIdRef.current;
    mediaRecorderRef.current = null;
    recordingAudioCtxRef.current = null;
    recordingStartedAtRef.current = null;
    if (!recorder || !startedAt || !thisCallId) return;

    recorder.onstop = () => {
      void ctx?.close();
      const chunks = recordingChunksRef.current;
      recordingChunksRef.current = [];
      if (chunks.length === 0) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      void uploadBinary("/api/intercom-recordings", blob, {
        callId: thisCallId,
        ...(kioskIdRef.current ? { kioskId: kioskIdRef.current } : {}),
        ...(pumpIdRef.current ? { pumpId: pumpIdRef.current } : {}),
        startedAt,
        endedAt: new Date().toISOString(),
      }).catch(() => {
        // Yukleme basarisiz olsa bile gorusme zaten bitmis - sessizce yoksayilir (best-effort).
      });
    };
    if (recorder.state !== "inactive") recorder.stop();
  }

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
        finishRecording();
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
        const remoteStream = event.streams[0] ?? null;
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;
          void remoteAudioRef.current
            .play()
            .then(() => setAudioBlocked(false))
            .catch(() => {
              // Otomatik oynatma tarayici tarafindan engellendi - UI'a bildir, kullanici
              // dogrudan bir tiklamayla (playRemoteAudio) tekrar deneyebilsin.
              setAudioBlocked(true);
            });
        }
        if (remoteStream) startRecording(remoteStream);
        setStatus("connected");
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) send({ kind: "ice", candidate: event.candidate.toJSON() });
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") {
          finishRecording();
          setStatus("error");
        } else if (pc.connectionState === "closed") {
          finishRecording();
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
      finishRecording();
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
    finishRecording();
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setStatus("ended");
  }

  function playRemoteAudio() {
    void remoteAudioRef.current
      ?.play()
      .then(() => setAudioBlocked(false))
      .catch(() => setAudioBlocked(true));
  }

  return { status, remoteAudioRef, audioBlocked, playRemoteAudio, hangUp };
}

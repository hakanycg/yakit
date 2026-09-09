import { useCallback, useEffect, useRef } from "react";

type Handler = (data: unknown) => void;

/**
 * Iki yonlu WS kanali: useTopicSubscription'in aksine yalnizca ALMAKLA kalmaz,
 * ayni topic'e abone diger istemcilere mesaj GONDERMEYI de saglar ("relay" mesaj
 * tipi, bkz. server/src/ws/hub.ts). Interkom (WebRTC SDP/ICE sinyallesmesi) icin
 * gerekli - useTopicSubscription yalnizca sunucunun broadcast() ettigi olaylari
 * dinler, istemciden istemciye gonderim yapamaz.
 */
export function useRelayChannel(topic: string | null, onMessage: Handler, accessToken?: string): { send: (data: unknown) => void } {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!topic) return;

    let closedByCleanup = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "subscribe", topic, accessToken }));
      });

      socket.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data) as { type: string; topic?: string; data?: unknown };
          if (msg.type === "relay" && msg.topic === topic) {
            handlerRef.current(msg.data);
          }
        } catch {
          // yoksay
        }
      });

      socket.addEventListener("close", () => {
        socketRef.current = null;
        if (!closedByCleanup) {
          retryTimer = setTimeout(connect, 2000);
        }
      });
    }

    connect();

    return () => {
      closedByCleanup = true;
      if (retryTimer) clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, accessToken]);

  const send = useCallback(
    (data: unknown) => {
      const socket = socketRef.current;
      if (topic && socket && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "relay", topic, data }));
      }
    },
    [topic]
  );

  return { send };
}

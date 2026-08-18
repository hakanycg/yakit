import { useEffect, useRef } from "react";

type Handler = (payload: unknown) => void;

/** Belirtilen topic'e abone olur; baglanti kopunca otomatik yeniden dener. */
export function useTopicSubscription(topic: string | null, onMessage: Handler, accessToken?: string): void {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    if (!topic) return;

    let socket: WebSocket | null = null;
    let closedByCleanup = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

      socket.addEventListener("open", () => {
        socket?.send(JSON.stringify({ type: "subscribe", topic, accessToken }));
      });

      socket.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data) as { type: string; topic?: string; payload?: unknown };
          if (msg.type === "event" && msg.topic === topic) {
            handlerRef.current(msg.payload);
          }
        } catch {
          // yoksay
        }
      });

      socket.addEventListener("close", () => {
        if (!closedByCleanup) {
          retryTimer = setTimeout(connect, 2000);
        }
      });
    }

    connect();

    return () => {
      closedByCleanup = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, accessToken]);
}

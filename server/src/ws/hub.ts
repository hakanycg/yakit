import { WebSocketServer, type WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import { parse as parseCookie } from "cookie";
import { resolveSession } from "../services/sessionService.js";
import { db } from "../db/index.js";
import type { RoleRow } from "../db/types.js";
import { SESSION_COOKIE } from "../middleware/auth.js";

interface ClientState {
  ws: WebSocket;
  role: "admin" | "operator" | "viewer" | null;
  topics: Set<string>;
}

const clients = new Set<ClientState>();

export function initWebSocketHub(server: HttpServer): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    let role: ClientState["role"] = null;
    const cookies = req.headers.cookie ? parseCookie(req.headers.cookie) : {};
    const token = cookies[SESSION_COOKIE];
    if (token) {
      const resolved = resolveSession(token);
      if (resolved) {
        const roleRow = db.prepare<[number], RoleRow>("SELECT * FROM roles WHERE id = ?").get(resolved.user.role_id);
        role = roleRow?.name ?? null;
      }
    }

    const state: ClientState = { ws, role, topics: new Set() };
    clients.add(state);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; topic?: string; accessToken?: string };
        if (msg.type === "subscribe" && msg.topic) {
          if (isTopicAllowed(msg.topic, role, msg.accessToken)) {
            state.topics.add(msg.topic);
          }
        } else if (msg.type === "unsubscribe" && msg.topic) {
          state.topics.delete(msg.topic);
        }
      } catch {
        // gecersiz mesajlari sessizce yok say
      }
    });

    ws.on("close", () => {
      clients.delete(state);
    });

    ws.send(JSON.stringify({ type: "connected", role }));
  });
}

/** "pumps" topigi herkese acik (kiosk dahil); islem detaylari icin dogru accessToken sarttir. */
function isTopicAllowed(topic: string, role: ClientState["role"], accessToken?: string): boolean {
  if (topic === "pumps") return true;
  if (role === "admin" || role === "operator") {
    if (topic === "transactions" || topic === "alarms") return true;
  }
  if (topic.startsWith("transaction:")) {
    const id = Number(topic.slice("transaction:".length));
    if (!Number.isInteger(id)) return false;
    if (role === "admin" || role === "operator") return true;
    if (!accessToken) return false;
    const row = db
      .prepare<[number], { kiosk_access_token: string }>("SELECT kiosk_access_token FROM transactions WHERE id = ?")
      .get(id);
    return !!row && row.kiosk_access_token === accessToken;
  }
  return false;
}

export function broadcast(topic: string, payload: unknown): void {
  const message = JSON.stringify({ type: "event", topic, payload });
  for (const client of clients) {
    if (client.topics.has(topic) && client.ws.readyState === client.ws.OPEN) {
      client.ws.send(message);
    }
  }
}

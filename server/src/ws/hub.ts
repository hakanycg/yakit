import { WebSocketServer, type WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import { parse as parseCookie } from "cookie";
import { resolveSession } from "../services/sessionService.js";
import { db } from "../db/index.js";
import type { RoleName, RoleRow } from "../db/types.js";
import { SESSION_COOKIE } from "../middleware/auth.js";
import { safeCompare } from "../utils/safeCompare.js";

type ClientRole = RoleName | null;

interface ClientState {
  ws: WebSocket;
  role: ClientRole;
  stationId: number | null;
  topics: Set<string>;
}

const clients = new Set<ClientState>();

export function initWebSocketHub(server: HttpServer): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    let role: ClientRole = null;
    let stationId: number | null = null;
    const cookies = req.headers.cookie ? parseCookie(req.headers.cookie) : {};
    const token = cookies[SESSION_COOKIE];
    if (token) {
      const resolved = resolveSession(token);
      if (resolved) {
        const roleRow = db.prepare<[number], RoleRow>("SELECT * FROM roles WHERE id = ?").get(resolved.user.role_id);
        role = roleRow?.name ?? null;
        stationId = resolved.user.station_id;
      }
    }

    const state: ClientState = { ws, role, stationId, topics: new Set() };
    clients.add(state);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; topic?: string; accessToken?: string; data?: unknown };
        if (msg.type === "subscribe" && msg.topic) {
          if (isTopicAllowed(msg.topic, state, msg.accessToken)) {
            state.topics.add(msg.topic);
          }
        } else if (msg.type === "unsubscribe" && msg.topic) {
          state.topics.delete(msg.topic);
        } else if (msg.type === "relay" && msg.topic) {
          // Istemciden istemciye yayin (ör. WebRTC SDP/ICE sinyallesmesi icin, bkz.
          // intercom ozelligi). Gonderenin bu topic'e ZATEN abone olmasi sart -
          // yetkilendirme subscribe asamasinda isTopicAllowed() ile yapildigindan,
          // burada ayrica bir yetki kontrolu tekrarlanmaz. Mesaj, ayni topic'e abone
          // DIGER (gonderen haric) tum istemcilere oldugu gibi iletilir.
          relay(msg.topic, msg.data, state);
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

function isStaffForStation(state: ClientState, stationId: number): boolean {
  if (state.role === "super_admin") return true;
  if (state.role !== "admin" && state.role !== "operator") return false;
  return state.stationId === stationId;
}

/** "pumps:<id>"/"fuel-stock:<id>"/"fuel-prices:<id>" herkese acik (kiosk dahil); "transactions:<id>"/"alarms:<id>" o istasyonun personeline veya super_admin'e ozeldir. */
function isTopicAllowed(topic: string, state: ClientState, accessToken?: string): boolean {
  if (topic.startsWith("pumps:") || topic.startsWith("fuel-stock:") || topic.startsWith("fuel-prices:")) {
    const prefix = topic.startsWith("pumps:") ? "pumps:" : topic.startsWith("fuel-stock:") ? "fuel-stock:" : "fuel-prices:";
    const stationId = Number(topic.slice(prefix.length));
    return Number.isInteger(stationId);
  }

  if (topic.startsWith("transactions:") || topic.startsWith("alarms:")) {
    const prefix = topic.startsWith("transactions:") ? "transactions:" : "alarms:";
    const stationId = Number(topic.slice(prefix.length));
    if (!Number.isInteger(stationId)) return false;
    return isStaffForStation(state, stationId);
  }

  if (topic.startsWith("transaction:")) {
    const id = Number(topic.slice("transaction:".length));
    if (!Number.isInteger(id)) return false;
    const row = db
      .prepare<[number], { kiosk_access_token: string; station_id: number }>(
        "SELECT kiosk_access_token, station_id FROM transactions WHERE id = ?"
      )
      .get(id);
    if (!row) return false;
    if (isStaffForStation(state, row.station_id)) return true;
    return !!accessToken && safeCompare(row.kiosk_access_token, accessToken);
  }

  // Interkom cagri bildirimi: yalnizca o istasyonun personeli dinler (alarms:<id> ile ayni desen).
  // Kiosk bu topic'e HIC abone olmaz - cagriyi POST /api/kiosk/intercom/ring uzerinden
  // sunucu broadcast() ile baslatir (bkz. routes/kiosk.ts).
  if (topic.startsWith("intercom-calls:")) {
    const stationId = Number(topic.slice("intercom-calls:".length));
    if (!Number.isInteger(stationId)) return false;
    return isStaffForStation(state, stationId);
  }

  // Interkom sinyallesme kanali ("intercom:<kioskId>:<callId>"): TS 12820 madde 4.9.3.5
  // geregi gorevlinin dagitim birimi bolgesindeki kisiyle her zaman iletisim
  // kurabilmesini saglayan iki yonlu WebRTC SDP/ICE degisimi buradan gecer. O kiosk'un
  // istasyonundaki personel VEYA kiosk'un kendisi (cihaz tokeniyle - transaction:<id>
  // ile ayni desen) abone olabilir.
  if (topic.startsWith("intercom:")) {
    const rest = topic.slice("intercom:".length);
    const kioskId = Number(rest.split(":")[0]);
    if (!Number.isInteger(kioskId)) return false;
    const kiosk = db
      .prepare<[number], { station_id: number; device_token: string | null }>(
        "SELECT station_id, device_token FROM station_kiosks WHERE id = ?"
      )
      .get(kioskId);
    if (!kiosk) return false;
    if (isStaffForStation(state, kiosk.station_id)) return true;
    return !!accessToken && !!kiosk.device_token && safeCompare(kiosk.device_token, accessToken);
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

/** Bir topic'e abone TUM DIGER istemcilere (gonderen haric) oldugu gibi iletir - client-to-client relay. */
function relay(topic: string, data: unknown, sender: ClientState): void {
  if (!sender.topics.has(topic)) return;
  const message = JSON.stringify({ type: "relay", topic, data });
  for (const client of clients) {
    if (client !== sender && client.topics.has(topic) && client.ws.readyState === client.ws.OPEN) {
      client.ws.send(message);
    }
  }
}

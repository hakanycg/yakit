import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openAgentDb } from "./db.js";
import { createAgentApp } from "./server.js";
import { saveCacheSnapshot } from "./cacheStore.js";
import { resetConnectivityState } from "./connectivity.js";

describe("agent local HTTP server", () => {
  let server: Server;
  let baseUrl: string;
  let db: ReturnType<typeof openAgentDb>;

  beforeEach(async () => {
    resetConnectivityState();
    db = openAgentDb(":memory:");
    const app = createAgentApp(db);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /status reports offline by default with zero pending events", async () => {
    const res = await fetch(`${baseUrl}/status`);
    const body = (await res.json()) as { online: boolean; pendingOutboxCount: number };
    expect(res.status).toBe(200);
    expect(body.online).toBe(false);
    expect(body.pendingOutboxCount).toBe(0);
  });

  it("POST /outbox queues an event and it is reflected in /status", async () => {
    const res = await fetch(`${baseUrl}/outbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "transaction_completed", payload: { amount: 250 } }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { status: string; clientEventId: string };
    expect(created.status).toBe("queued");
    expect(typeof created.clientEventId).toBe("string");

    const statusRes = await fetch(`${baseUrl}/status`);
    const status = (await statusRes.json()) as { pendingOutboxCount: number };
    expect(status.pendingOutboxCount).toBe(1);
  });

  it("POST /outbox rejects a request without eventType", async () => {
    const res = await fetch(`${baseUrl}/outbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /cache returns 404 before any snapshot has been pulled", async () => {
    const res = await fetch(`${baseUrl}/cache`);
    expect(res.status).toBe(404);
  });

  it("GET /cache returns the saved snapshot", async () => {
    saveCacheSnapshot(db, { fuelPrices: [{ fuelType: "benzin", pricePerLiter: 44.5 }] });
    const res = await fetch(`${baseUrl}/cache`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown };
    expect(body.data).toEqual({ fuelPrices: [{ fuelType: "benzin", pricePerLiter: 44.5 }] });
  });
});

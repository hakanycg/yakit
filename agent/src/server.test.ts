import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openAgentDb } from "./db.js";
import { createAgentApp } from "./server.js";
import { saveCacheSnapshot } from "./cacheStore.js";
import { resetConnectivityState } from "./connectivity.js";
import { noopPrinterDriver, setPrinterDriver } from "./printerDriver.js";
import { noopOkcDriver, setOkcDriver } from "./okcDriver.js";
import { noopPosDriver, setPosDriver } from "./posDriver.js";

describe("agent local HTTP server", () => {
  let server: Server;
  let baseUrl: string;
  let db: ReturnType<typeof openAgentDb>;

  beforeEach(async () => {
    resetConnectivityState();
    setPrinterDriver(noopPrinterDriver);
    setOkcDriver(noopOkcDriver);
    setPosDriver(noopPosDriver);
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

  it("POST /print returns printed:false with the noop driver (no physical printer yet)", async () => {
    const res = await fetch(`${baseUrl}/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Fis",
        lines: [{ label: "Plaka", value: "34ABC123" }],
        transactionId: 1,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { printed: boolean };
    expect(body.printed).toBe(false);
  });

  it("POST /print returns printed:true once a real driver is wired in", async () => {
    setPrinterDriver({ print: async () => ({ printed: true }) });
    const res = await fetch(`${baseUrl}/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Fis", lines: [], transactionId: 2 }),
    });
    const body = (await res.json()) as { printed: boolean };
    expect(body.printed).toBe(true);
  });

  it("POST /print queues a printer_fault outbox event when a real driver reports a physical fault", async () => {
    setPrinterDriver({ print: async () => ({ printed: false, faultCode: "PAPER_OUT" }) });
    const res = await fetch(`${baseUrl}/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Fis", lines: [], transactionId: 3 }),
    });
    const body = (await res.json()) as { printed: boolean; faultCode?: string };
    expect(body.printed).toBe(false);
    expect(body.faultCode).toBe("PAPER_OUT");

    const statusRes = await fetch(`${baseUrl}/status`);
    const status = (await statusRes.json()) as { pendingOutboxCount: number };
    expect(status.pendingOutboxCount).toBe(1);
  });

  it("POST /print does NOT queue a printer_fault event when the noop driver simply has no hardware", async () => {
    const res = await fetch(`${baseUrl}/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Fis", lines: [], transactionId: 4 }),
    });
    const body = (await res.json()) as { printed: boolean; faultCode?: string };
    expect(body.printed).toBe(false);
    expect(body.faultCode).toBeUndefined();

    const statusRes = await fetch(`${baseUrl}/status`);
    const status = (await statusRes.json()) as { pendingOutboxCount: number };
    expect(status.pendingOutboxCount).toBe(0);
  });

  it("POST /okc/print returns printed:false with the noop driver (no fiscal ÖKC yet)", async () => {
    const res = await fetch(`${baseUrl}/okc/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Fis", lines: [], transactionId: 1, amount: 250.5 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { printed: boolean };
    expect(body.printed).toBe(false);
  });

  it("POST /okc/print returns the fiscal number once a real ÖKC driver is wired in", async () => {
    setOkcDriver({ printFiscalReceipt: async () => ({ printed: true, fiscalNo: "Z-000123" }) });
    const res = await fetch(`${baseUrl}/okc/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Fis", lines: [], transactionId: 2, amount: 100 }),
    });
    const body = (await res.json()) as { printed: boolean; fiscalNo?: string };
    expect(body.printed).toBe(true);
    expect(body.fiscalNo).toBe("Z-000123");
  });

  it("POST /okc/print queues an okc_fault outbox event when a real driver reports a physical fault", async () => {
    setOkcDriver({ printFiscalReceipt: async () => ({ printed: false, faultCode: "OFFLINE" }) });
    const res = await fetch(`${baseUrl}/okc/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Fis", lines: [], transactionId: 3, amount: 100 }),
    });
    const body = (await res.json()) as { printed: boolean; faultCode?: string };
    expect(body.printed).toBe(false);
    expect(body.faultCode).toBe("OFFLINE");

    const statusRes = await fetch(`${baseUrl}/status`);
    const status = (await statusRes.json()) as { pendingOutboxCount: number };
    expect(status.pendingOutboxCount).toBe(1);
  });

  it("POST /okc/print rejects a request without an amount", async () => {
    const res = await fetch(`${baseUrl}/okc/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Fis", lines: [], transactionId: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /print rejects a request without a title", async () => {
    const res = await fetch(`${baseUrl}/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines: [], transactionId: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /pos/charge returns success:false with the noop driver (no physical POS yet)", async () => {
    const res = await fetch(`${baseUrl}/pos/charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: 1, amount: 250.5 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; faultCode?: string };
    expect(body.success).toBe(false);
    expect(body.faultCode).toBeUndefined();

    const statusRes = await fetch(`${baseUrl}/status`);
    const status = (await statusRes.json()) as { pendingOutboxCount: number };
    expect(status.pendingOutboxCount).toBe(0);
  });

  it("POST /pos/charge returns a reference id once a real driver is wired in", async () => {
    setPosDriver({ chargeContactless: async () => ({ success: true, referenceId: "REF-1", message: "Tahsil edildi." }) });
    const res = await fetch(`${baseUrl}/pos/charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: 2, amount: 100 }),
    });
    const body = (await res.json()) as { success: boolean; referenceId?: string };
    expect(body.success).toBe(true);
    expect(body.referenceId).toBe("REF-1");
  });

  it("POST /pos/charge queues a pos_fault outbox event when a real driver reports a physical fault", async () => {
    setPosDriver({ chargeContactless: async () => ({ success: false, faultCode: "DECLINED", message: "Reddedildi." }) });
    const res = await fetch(`${baseUrl}/pos/charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: 3, amount: 100 }),
    });
    const body = (await res.json()) as { success: boolean; faultCode?: string };
    expect(body.success).toBe(false);
    expect(body.faultCode).toBe("DECLINED");

    const statusRes = await fetch(`${baseUrl}/status`);
    const status = (await statusRes.json()) as { pendingOutboxCount: number };
    expect(status.pendingOutboxCount).toBe(1);
  });

  it("POST /pos/charge rejects a request without an amount", async () => {
    const res = await fetch(`${baseUrl}/pos/charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("responds to CORS preflight (OPTIONS) requests", async () => {
    const res = await fetch(`${baseUrl}/print`, { method: "OPTIONS", headers: { Origin: "https://station.example.com" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://station.example.com");
  });
});

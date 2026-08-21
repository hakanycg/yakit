import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAgentDb } from "./db.js";
import { enqueueEvent, getPendingEvents } from "./outboxService.js";
import { readCacheSnapshot } from "./cacheStore.js";
import { getConnectivityState, resetConnectivityState } from "./connectivity.js";
import { flushOutbox, pullCache, sendHeartbeat } from "./syncClient.js";

const BASE_URL = "http://central.test";
const TOKEN = "test-sync-token";

beforeEach(() => {
  resetConnectivityState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("syncClient - sendHeartbeat", () => {
  it("marks connectivity online on a successful heartbeat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendHeartbeat(BASE_URL, TOKEN);

    expect(getConnectivityState().online).toBe(true);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>)["X-Station-Sync-Token"]).toBe(TOKEN);
  });

  it("marks connectivity offline when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await sendHeartbeat(BASE_URL, TOKEN);

    const state = getConnectivityState();
    expect(state.online).toBe(false);
    expect(state.lastError).toContain("network down");
  });

  it("marks connectivity offline on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("gecersiz token", { status: 401, statusText: "Unauthorized" })));

    await sendHeartbeat(BASE_URL, TOKEN);

    expect(getConnectivityState().online).toBe(false);
  });
});

describe("syncClient - flushOutbox", () => {
  it("does nothing when the outbox is empty", async () => {
    const db = openAgentDb(":memory:");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await flushOutbox(db, BASE_URL, TOKEN);

    expect(result.sent).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends pending events and marks stored/duplicate ones as sent", async () => {
    const db = openAgentDb(":memory:");
    const a = enqueueEvent(db, "transaction_completed", { amount: 100 });
    const b = enqueueEvent(db, "transaction_completed", { amount: 200 });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              { clientEventId: a.clientEventId, status: "stored" },
              { clientEventId: b.clientEventId, status: "duplicate" },
            ],
          }),
          { status: 200 }
        )
      )
    );

    const result = await flushOutbox(db, BASE_URL, TOKEN);

    expect(result.sent).toBe(2);
    expect(getPendingEvents(db)).toHaveLength(0);
  });

  it("leaves events pending (for retry) when the request fails", async () => {
    const db = openAgentDb(":memory:");
    enqueueEvent(db, "transaction_completed", { amount: 100 });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    const result = await flushOutbox(db, BASE_URL, TOKEN);

    expect(result.sent).toBe(0);
    expect(getPendingEvents(db)).toHaveLength(1);
    expect(getConnectivityState().online).toBe(false);
  });
});

describe("syncClient - pullCache", () => {
  it("saves the fetched snapshot locally on success", async () => {
    const db = openAgentDb(":memory:");
    const snapshotBody = { generatedAt: "2026-01-01T00:00:00.000Z", fuelPrices: [], pumps: [], fleetAccounts: [] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshotBody), { status: 200 })));

    await pullCache(db, BASE_URL, TOKEN);

    expect(readCacheSnapshot(db)!.data).toEqual(snapshotBody);
    expect(getConnectivityState().online).toBe(true);
  });

  it("keeps the previous snapshot when the pull fails", async () => {
    const db = openAgentDb(":memory:");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ v: 1 }), { status: 200 })));
    await pullCache(db, BASE_URL, TOKEN);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await pullCache(db, BASE_URL, TOKEN);

    expect(readCacheSnapshot(db)!.data).toEqual({ v: 1 });
    expect(getConnectivityState().online).toBe(false);
  });
});

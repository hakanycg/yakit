import { describe, expect, it } from "vitest";
import { openAgentDb } from "./db.js";
import { readCacheSnapshot, saveCacheSnapshot } from "./cacheStore.js";

describe("cacheStore", () => {
  it("returns null when no snapshot has been saved yet", () => {
    const db = openAgentDb(":memory:");
    expect(readCacheSnapshot(db)).toBeNull();
  });

  it("saves and reads back a snapshot", () => {
    const db = openAgentDb(":memory:");
    saveCacheSnapshot(db, { fuelPrices: [{ fuelType: "benzin", pricePerLiter: 44.5 }] });

    const snapshot = readCacheSnapshot(db);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.data).toEqual({ fuelPrices: [{ fuelType: "benzin", pricePerLiter: 44.5 }] });
  });

  it("overwrites the previous snapshot rather than accumulating rows", () => {
    const db = openAgentDb(":memory:");
    saveCacheSnapshot(db, { v: 1 });
    saveCacheSnapshot(db, { v: 2 });

    const count = (db.prepare("SELECT COUNT(*) as c FROM cache_snapshot").get() as { c: number }).c;
    expect(count).toBe(1);
    expect(readCacheSnapshot(db)!.data).toEqual({ v: 2 });
  });
});

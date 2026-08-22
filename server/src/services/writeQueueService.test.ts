import { afterEach, describe, expect, it } from "vitest";
import {
  enqueueWrite,
  getWriteQueueRow,
  processWriteQueue,
  pruneWriteQueue,
  registerWriteQueueHandler,
  resetWriteQueueHandlers,
} from "./writeQueueService.js";
import { db } from "../db/index.js";

// Bu test dosyasi calisirken registerWriteQueueHandler ile eklenen handler'lar diger
// test dosyalarini (ör. alarmService'in kendi kaydettigi handler) etkilemesin diye
// her testten sonra sifirlanir - paylasilan modul-seviyesi Map oldugundan izolasyon
// gerekir (bkz. vitest.config.ts: fileParallelism false, tum testler ayni surecte).
afterEach(() => {
  resetWriteQueueHandlers();
});

describe("writeQueueService", () => {
  it("enqueue edilen bir is, kayitli handler'i cagirir ve islenmis olarak isaretlenir", async () => {
    const calls: unknown[] = [];
    registerWriteQueueHandler("test_success", (payload) => {
      calls.push(payload);
    });
    const id = enqueueWrite("test_success", { foo: "bar" });

    await processWriteQueue();

    expect(calls).toEqual([{ foo: "bar" }]);
    const row = getWriteQueueRow(id);
    expect(row?.processed_at).not.toBeNull();
    expect(row?.attempts).toBe(0);
  });

  it("handler'i kayitli olmayan bir is turunu, sonsuza dek takilip kalmamasi icin islenmis sayar", async () => {
    const id = enqueueWrite("test_unknown_kind_xyz", { anything: true });
    await processWriteQueue();
    const row = getWriteQueueRow(id);
    expect(row?.processed_at).not.toBeNull();
  });

  it("basarisiz olan bir isi azami deneme sayisina kadar tekrar dener, sonra vazgecer", async () => {
    let attemptCount = 0;
    registerWriteQueueHandler("test_always_fails", () => {
      attemptCount += 1;
      throw new Error("simulated failure");
    });
    const id = enqueueWrite("test_always_fails", {});

    // MAX_ATTEMPTS = 5 (writeQueueService.ts icinde sabit) - her cagri bir deneme sayar.
    for (let i = 0; i < 5; i++) {
      await processWriteQueue();
    }

    expect(attemptCount).toBe(5);
    const row = getWriteQueueRow(id);
    expect(row?.attempts).toBe(5);
    expect(row?.processed_at).not.toBeNull(); // vazgecildi, sonsuza dek denemeye devam etmiyor
    expect(row?.last_error).toContain("simulated failure");
  });

  it("gecici olarak basarisiz olan bir is, sonraki turda basarili olursa islenir", async () => {
    let shouldFail = true;
    registerWriteQueueHandler("test_flaky", () => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("gecici hata");
      }
    });
    const id = enqueueWrite("test_flaky", {});

    await processWriteQueue();
    let row = getWriteQueueRow(id);
    expect(row?.processed_at).toBeNull();
    expect(row?.attempts).toBe(1);

    await processWriteQueue();
    row = getWriteQueueRow(id);
    expect(row?.processed_at).not.toBeNull();
    expect(row?.attempts).toBe(1);
  });

  it("pruneWriteQueue yalnizca eski VE islenmis kayitlari siler", async () => {
    registerWriteQueueHandler("test_prune", () => {});
    const oldProcessedId = enqueueWrite("test_prune", {});
    await processWriteQueue();
    db.prepare("UPDATE write_queue SET processed_at = ? WHERE id = ?").run(
      new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      oldProcessedId
    );

    const recentPendingId = enqueueWrite("test_prune_unregistered_kind_keep", {});

    pruneWriteQueue(7 * 24 * 60 * 60 * 1000);

    expect(getWriteQueueRow(oldProcessedId)).toBeNull();
    expect(getWriteQueueRow(recentPendingId)).not.toBeNull();
  });
});

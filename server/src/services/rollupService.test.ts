import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { StationRow } from "../db/types.js";
import { createTestPump, createTestStation } from "../test/dbFixture.js";
import { getLiveTotalsForDate, getRollupTotals, isDateRollupCovered, refreshRollups } from "./rollupService.js";

let station: StationRow;

function addSale(at: string, amount: number, opts: { discount?: number; liters?: number; status?: string } = {}): void {
  const pumpId = createTestPump(station.id);
  db.prepare(
    `INSERT INTO transactions
       (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters,
        total_amount, discount_amount, payment_status, status, kiosk_access_token, created_at, completed_at)
     VALUES (?, ?, '34ABC01', 'motorin', 'amount', 45, ?, ?, ?, 'captured', ?, ?, ?, ?)`
  ).run(
    station.id,
    pumpId,
    opts.liters ?? 10,
    amount,
    opts.discount ?? 0,
    opts.status ?? "completed",
    `tok-${Math.random().toString(16).slice(2)}`,
    at,
    at
  );
}

beforeEach(() => {
  station = createTestStation();
  db.prepare("DELETE FROM rollup_state").run();
  db.prepare("DELETE FROM station_daily_rollups").run();
});

describe("refreshRollups - ilk calistirma (backfill)", () => {
  // NOT: "hic tamamlanmis islem yok" durumu burada GLOBAL olarak (baska test
  // dosyalarinin biraktigi satirlar dahil) sinanamaz - earliestBusinessDate() bilerek
  // tum istasyonlari kapsar (bkz. yorum: backfill TUM istasyonlari doldurmali) ve
  // fileParallelism:false ile ayni SQLite dosyasini paylasan baska bir dosya cok
  // once bir islem yazmis olabilir. Bu yuzden yalnizca HER DURUMDA (bos ya da dolu)
  // dogru olan degismezi sinariz: calistirma sonrasi bugun her zaman kapsamda olur.
  it("calistirma sonrasi bugun her zaman kapsamda olur", () => {
    const now = new Date("2026-08-20T12:00:00.000Z");
    const result = refreshRollups(now);

    expect(result.wasBackfill).toBe(true);
    expect(isDateRollupCovered("2026-08-20")).toBe(true);
  });

  it("EN ESKI islemden bugune kadar tek seferde geriye doldurur", () => {
    // NOT: "en eski tarih TAM OLARAK bu" diye iddia edilmiyor - baska test dosyalari
    // (fileParallelism:false ile ayni SQLite dosyasini paylasarak) kendi eski tarihli
    // islemlerini yazmis olabilir (ör. KVKK saklama testleri). Bu yuzden sinanan sey
    // "en eski tarih HESAPLANAN sonuc, en azindan BENIM islemim kadar geriye gider"
    // ve "benim istasyonumun rollup toplami dogru" - global minimumun DEGERI degil.
    addSale("2026-06-01T09:00:00.000Z", 100);
    addSale("2026-08-15T09:00:00.000Z", 200);

    const now = new Date("2026-08-20T12:00:00.000Z");
    const result = refreshRollups(now);

    expect(result.wasBackfill).toBe(true);
    expect(result.from).not.toBeNull();
    expect(result.from! <= "2026-06-01").toBe(true);
    expect(isDateRollupCovered("2026-06-01")).toBe(true);

    const totals = getRollupTotals(null, "2026-06-01", "2026-08-20");
    expect(totals.get(station.id)?.revenue).toBe(300);
    expect(totals.get(station.id)?.transactionCount).toBe(2);
  });
});

describe("refreshRollups - kayan pencere", () => {
  it("ikinci calistirmada yalnizca son 7 gunu yeniden hesaplar, eskiyi GERI CEKMEZ", () => {
    addSale("2026-06-01T09:00:00.000Z", 100);
    const now = new Date("2026-08-20T12:00:00.000Z");
    refreshRollups(now); // backfill: covered_from = 2026-06-01

    // Eski gune sonradan bir satis eklensin (ör. gec islenen bir kayit) - pencere
    // disinda kaldigi icin ikinci calistirma bunu YAKALAMAMALI (kasitli sinir).
    addSale("2026-06-01T10:00:00.000Z", 50);
    refreshRollups(new Date(now.getTime() + 60_000));

    expect(isDateRollupCovered("2026-06-01")).toBe(true); // kapsam GERI CEKILMEDI
    const totals = getRollupTotals(null, "2026-06-01", "2026-06-01");
    // Ikinci calistirma 2026-06-01'i yeniden HESAPLAMADI (pencere disinda), o yuzden
    // rollup hala ILK degeri (100) tasiyor - yeni eklenen 50 henuz yansimadi.
    expect(totals.get(station.id)?.revenue).toBe(100);
  });

  it("pencere icindeki gec gelen bir duzeltmeyi bir sonraki calistirmada yansitir", () => {
    const now = new Date("2026-08-20T12:00:00.000Z");
    addSale("2026-08-18T09:00:00.000Z", 100);
    refreshRollups(now);
    expect(getRollupTotals(null, "2026-08-18", "2026-08-18").get(station.id)?.revenue).toBe(100);

    // 2026-08-18, 7 gunluk pencerenin (2026-08-14..2026-08-20) icinde - gec gelen
    // duzeltme bir sonraki calistirmada YAKALANMALI.
    addSale("2026-08-18T10:00:00.000Z", 25);
    refreshRollups(new Date(now.getTime() + 60_000));

    expect(getRollupTotals(null, "2026-08-18", "2026-08-18").get(station.id)?.revenue).toBe(125);
  });

  it("idempotenttir - ayni pencereyi iki kez calistirmak ayni sonucu verir", () => {
    const now = new Date("2026-08-20T12:00:00.000Z");
    addSale("2026-08-18T09:00:00.000Z", 100, { liters: 15 });
    refreshRollups(now);
    refreshRollups(new Date(now.getTime() + 1000));

    const totals = getRollupTotals(null, "2026-08-18", "2026-08-18");
    expect(totals.get(station.id)).toEqual({ transactionCount: 1, revenue: 100, discount: 0, liters: 15 });
  });
});

describe("getLiveTotalsForDate", () => {
  it("rollup tablosuna YAZMADAN tek bir gunun toplamini canli doner", () => {
    addSale("2026-08-20T09:00:00.000Z", 300, { liters: 12 });

    const totals = getLiveTotalsForDate(null, "2026-08-20");

    expect(totals.get(station.id)).toEqual({ transactionCount: 1, revenue: 300, discount: 0, liters: 12 });
    // Kalici bir yan etkisi olmamali.
    const rows = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM station_daily_rollups").get()!;
    expect(rows.c).toBe(0);
  });
});

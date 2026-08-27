/**
 * Kapasite olcumu (gorev #154).
 *
 * Gorev #81 (veri merkezi/sunucu secimi) "kac CPU, kac GB RAM, kac GB disk" sorusuna
 * cevap istiyor. Bu soru TAHMINLE cevaplanamaz - "SQLite hizlidir" ya da "bin istasyon
 * cok degil" cumlelerinin ikisi de olculmeden hicbir sey ifade etmez. Bu betik gercek
 * veri uretip gercek sorgulari calistirir ve #81'e SAYI verir.
 *
 * Kullanim:
 *   npm run benchmark
 *   npm run benchmark -- --stations=200 --days=90 --tx=300
 *
 * ONEMLI: Kendi GECICI veritabaninda calisir (data/benchmark.sqlite), her calismada
 * sifirdan olusturulur. Canli/gelistirme veritabanina DOKUNMAZ - bu yuzden DATABASE_PATH
 * daha ilk satirda, db modulu yuklenmeden once sabitlenir ve db'ye dokunan her sey
 * dinamik import ile alinir (statik import olsaydi hoisting yuzunden db modulu bu
 * atamadan ONCE calisir ve gercek veritabanini acardi).
 */
import { rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

interface Options {
  stations: number;
  days: number;
  txPerStationDay: number;
  repeats: number;
}

function parseArgs(): Options {
  const get = (name: string, fallback: number): number => {
    const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (!arg) return fallback;
    const value = Number(arg.split("=")[1]);
    if (!Number.isFinite(value) || value <= 0) {
      console.error(`Gecersiz --${name} degeri.`);
      process.exit(1);
    }
    return Math.floor(value);
  };
  return {
    // Varsayilanlar bilerek MUTEVAZI: betigin bir kahve molasi degil, birkac dakika
    // surmesi lazim ki gercekten calistirilsin. Buyuk olcek icin --stations ile artirilir.
    stations: get("stations", 50),
    days: get("days", 30),
    txPerStationDay: get("tx", 200),
    repeats: get("repeats", 20),
  };
}

const opts = parseArgs();

const BENCH_DB = resolve(process.cwd(), "data/benchmark.sqlite");
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${BENCH_DB}${suffix}`, { force: true });
}
process.env.DATABASE_PATH = "./data/benchmark.sqlite";
process.env.SESSION_SECRET ??= "benchmark-session-secret-must-be-at-least-32-chars";
process.env.NODE_ENV ??= "production";

const { db, applySchema, applyMigrations } = await import("../db/index.js");
const { getPortfolioReport } = await import("../services/portfolioService.js");
const { refreshRollups } = await import("../services/rollupService.js");

applySchema();
applyMigrations();

const FUEL_TYPES = ["benzin", "motorin", "lpg"] as const;
const PUMPS_PER_STATION = 6;
const STATIONS_PER_TENANT = 20;

function iso(daysAgo: number, secondOfDay: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + secondOfDay * 1000).toISOString();
}

function seed(): void {
  const started = Date.now();
  console.log(
    `Tohumlama: ${opts.stations} istasyon x ${opts.days} gun x ${opts.txPerStationDay} islem/gun ` +
      `= ${(opts.stations * opts.days * opts.txPerStationDay).toLocaleString("tr")} islem\n`
  );

  db.prepare("INSERT OR IGNORE INTO roles (name, description) VALUES ('admin', '')").run();
  const roleId = db.prepare<[], { id: number }>("SELECT id FROM roles WHERE name = 'admin'").get()!.id;

  const insertTenant = db.prepare("INSERT INTO tenants (name, slug) VALUES (?, ?)");
  const insertStation = db.prepare("INSERT INTO stations (slug, code, name, address, tenant_id) VALUES (?, ?, ?, ?, ?)");
  const insertPump = db.prepare("INSERT INTO pumps (station_id, number, label, status, fuel_types) VALUES (?, ?, ?, 'idle', ?)");
  const insertTank = db.prepare(
    "INSERT INTO fuel_tanks (station_id, fuel_type, capacity_liters, current_liters, low_stock_threshold_liters) VALUES (?, ?, 20000, 12000, 2000)"
  );
  const insertPrice = db.prepare("INSERT INTO fuel_prices (station_id, fuel_type, label, price_per_liter) VALUES (?, ?, ?, ?)");
  const insertUser = db.prepare(
    `INSERT INTO users (username, display_name, password_hash, password_salt, password_iterations, role_id, station_id)
     VALUES (?, ?, 'x', 'x', 1, ?, ?)`
  );

  const stationIds: number[] = [];
  const pumpsByStation = new Map<number, number[]>();

  db.transaction(() => {
    let tenantId = 0;
    for (let s = 0; s < opts.stations; s++) {
      if (s % STATIONS_PER_TENANT === 0) {
        tenantId = insertTenant.run(`Dagitim ${s / STATIONS_PER_TENANT + 1}`, `dagitim-${s}`).lastInsertRowid as number;
      }
      const stationId = insertStation.run(`istasyon-${s}`, `BM${String(s).padStart(6, "0")}`, `Istasyon ${s}`, "Adres", tenantId)
        .lastInsertRowid as number;
      stationIds.push(stationId);

      const pumps: number[] = [];
      for (let p = 1; p <= PUMPS_PER_STATION; p++) {
        pumps.push(insertPump.run(stationId, p, `Pompa ${p}`, JSON.stringify(FUEL_TYPES)).lastInsertRowid as number);
      }
      pumpsByStation.set(stationId, pumps);

      for (const f of FUEL_TYPES) {
        insertTank.run(stationId, f);
        insertPrice.run(stationId, f, f, 40 + Math.random() * 10);
      }
      insertUser.run(`bench-user-${s}`, `Bench ${s}`, roleId, stationId);
    }
  })();

  const insertTx = db.prepare(
    `INSERT INTO transactions
       (station_id, pump_id, plate, fuel_type, amount_mode, requested_amount, price_per_liter, total_amount,
        discount_amount, dispensed_liters, kiosk_access_token, status, payment_status, created_at, completed_at)
     VALUES (?, ?, ?, ?, 'amount', ?, ?, ?, ?, ?, ?, ?, 'captured', ?, ?)`
  );
  const insertAudit = db.prepare(
    "INSERT INTO audit_log (station_id, user_id, username, actor_type, action, created_at) VALUES (?, NULL, 'bench', 'staff', ?, ?)"
  );
  const insertReading = db.prepare(
    `INSERT INTO fuel_tank_readings
       (station_id, fuel_type, measured_liters, book_liters, variance_liters, throughput_liters, variance_pct, measured_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'auto')`
  );
  const insertAlarm = db.prepare(
    "INSERT INTO alarms (station_id, type, severity, message, status, created_at) VALUES (?, 'bench', 'warning', 'Bench alarm', ?, ?)"
  );

  let txCount = 0;
  // Gun gun ilerlenir ve her gun tek bir islemde yazilir: hepsini tek dev islemde
  // yazmak WAL'i sisirir, satir satir yazmak ise her satir icin fsync demektir.
  for (let day = opts.days - 1; day >= 0; day--) {
    db.transaction(() => {
      for (const stationId of stationIds) {
        const pumps = pumpsByStation.get(stationId)!;
        for (let i = 0; i < opts.txPerStationDay; i++) {
          const fuel = FUEL_TYPES[i % FUEL_TYPES.length]!;
          const price = 40 + (i % 10);
          const liters = 20 + (i % 40);
          const total = price * liters;
          // Islemlerin %4'u iptal/basarisiz: rapor sorgularinin CASE WHEN status
          // dallari gercekten calissin, hepsi 'completed' olan yapay bir dagilim olmasin.
          const status = i % 25 === 0 ? "cancelled" : "completed";
          const at = iso(day, (i * 86_400) / opts.txPerStationDay);
          insertTx.run(
            stationId,
            pumps[i % pumps.length]!,
            `34BM${String(i % 5000).padStart(4, "0")}`,
            fuel,
            total,
            price,
            total,
            i % 7 === 0 ? 10 : 0,
            liters,
            `bench-${stationId}-${day}-${i}`,
            status,
            at,
            status === "completed" ? at : null
          );
          txCount++;
        }
        // Istasyon basina gunde ~10 denetim kaydi, saatte 1 tank olcumu (3 yakit),
        // ~2 gunde 1 alarm - uretimdeki oranlara yakin.
        for (let a = 0; a < 10; a++) insertAudit.run(stationId, "bench_action", iso(day, a * 8000));
        for (let h = 0; h < 24; h++) {
          for (const f of FUEL_TYPES) insertReading.run(stationId, f, 12000, 12010, -10, 500, -2, iso(day, h * 3600));
        }
        if (day % 2 === 0) insertAlarm.run(stationId, day % 6 === 0 ? "active" : "resolved", iso(day, 3600));
      }
    })();
    if (day % 10 === 0) process.stdout.write(`  ${opts.days - day}/${opts.days} gun\r`);
  }

  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("ANALYZE");
  console.log(`\nTohumlama bitti: ${txCount.toLocaleString("tr")} islem, ${((Date.now() - started) / 1000).toFixed(1)} sn\n`);
}

interface Measurement {
  name: string;
  p50: number;
  p95: number;
  max: number;
}

function measure(name: string, run: () => void): Measurement {
  // Isinma: ilk calisma sayfa onbellegini ve sorgu planini doldurur; onu olcuye katmak
  // gercek kullanimda ASLA gorulmeyecek bir sayiyi rapor etmek olurdu.
  run();
  const samples: number[] = [];
  for (let i = 0; i < opts.repeats; i++) {
    const t0 = performance.now();
    run();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))]!;
  return { name, p50: at(0.5), p95: at(0.95), max: samples[samples.length - 1]! };
}

function runQueries(): Measurement[] {
  const stationIds = db.prepare<[], { id: number }>("SELECT id FROM stations").all().map((r) => r.id);
  const pick = () => stationIds[Math.floor(Math.random() * stationIds.length)]!;
  const from = iso(opts.days - 1, 0).slice(0, 10);
  const to = iso(0, 0).slice(0, 10);
  const toEnd = `${to}T23:59:59.999Z`;

  const results: Measurement[] = [];

  results.push(
    measure("Rapor ozeti (tek istasyon, tum aralik)", () => {
      db.prepare(
        `SELECT COUNT(*) as c,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN MAX(0, total_amount - discount_amount) ELSE 0 END), 0) as revenue,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN dispensed_liters ELSE 0 END), 0) as liters
         FROM transactions WHERE station_id = ? AND created_at >= ? AND created_at <= ?`
      ).get(pick(), from, toEnd);
    })
  );

  results.push(
    measure("Rapor: yakit tipine gore kirilim", () => {
      db.prepare(
        `SELECT fuel_type, COUNT(*) as c, COALESCE(SUM(total_amount), 0) as revenue
         FROM transactions WHERE station_id = ? AND status = 'completed' AND created_at >= ? AND created_at <= ?
         GROUP BY fuel_type`
      ).all(pick(), from, toEnd);
    })
  );

  results.push(
    measure("Islem listesi (son 50, tek istasyon)", () => {
      db.prepare("SELECT * FROM transactions WHERE station_id = ? ORDER BY created_at DESC LIMIT 50").all(pick());
    })
  );

  results.push(
    measure("Plaka gecmisi (tek istasyon, tek plaka)", () => {
      db.prepare(
        "SELECT * FROM transactions WHERE station_id = ? AND plate = ? ORDER BY created_at DESC LIMIT 20"
      ).all(pick(), "34BM0042");
    })
  );

  // GERCEK uretim fonksiyonu cagriliyor, elle yazilmis bir benzeri degil. Ilk surumde
  // burada kendi yazdigim basit bir "created_at BETWEEN" sorgusu vardi ve GERCEGINDEN
  // COK DAHA IYIMSER bir sayi uretiyordu: uretimdeki sorgu tarihi
  // date(COALESCE(completed_at, created_at), '+3 hours') ile IS GUNUNE ceviriyor ve
  // kolonu bir ifadeye sardigi icin duz indeks kullanamiyor. Olcum, olculen seyin
  // kendisi olmali.
  results.push(measure("Konsolide rapor - ROLLUP OLMADAN (eski/yedek yol)", () => {
    getPortfolioReport({ tenantId: null }, from, to);
  }));

  // Rollup'in TEK SEFERLIK geriye doldurma (backfill) maliyeti - olcege bagli, ama
  // BIR KEZ odenir (bkz. rollupService.ts). measure() burada kullanilmiyor: sadece
  // bir kez calisir, tekrar tekrar olculecek bir sey degil.
  const backfillStart = performance.now();
  const backfillResult = refreshRollups();
  const backfillMs = performance.now() - backfillStart;
  console.log(
    `\nRollup ilk geriye doldurma: ${backfillMs.toFixed(1)} ms (${backfillResult.rowsWritten.toLocaleString("tr")} istasyon-gun satiri, tek seferlik)`
  );

  results.push(measure("Konsolide rapor - ROLLUP ILE (yeni/hizli yol)", () => {
    getPortfolioReport({ tenantId: null }, from, to);
  }));

  results.push(
    measure("Acik alarmlar (tek istasyon)", () => {
      db.prepare("SELECT * FROM alarms WHERE station_id = ? AND status = 'active' ORDER BY created_at DESC").all(pick());
    })
  );

  results.push(
    measure("Denetim kaydi (tek istasyon, son 100)", () => {
      db.prepare("SELECT * FROM audit_log WHERE station_id = ? ORDER BY created_at DESC LIMIT 100").all(pick());
    })
  );

  results.push(
    measure("Sapma gecmisi (tek istasyon/yakit, son 50 olcum)", () => {
      db.prepare(
        "SELECT * FROM fuel_tank_readings WHERE station_id = ? AND fuel_type = 'benzin' ORDER BY measured_at DESC LIMIT 50"
      ).all(pick());
    })
  );

  results.push(
    measure("Kiosk: islem olusturma oncesi fiyat + tank", () => {
      const stationId = pick();
      db.prepare("SELECT * FROM fuel_prices WHERE station_id = ? AND fuel_type = 'benzin'").get(stationId);
      db.prepare("SELECT * FROM fuel_tanks WHERE station_id = ? AND fuel_type = 'benzin'").get(stationId);
    })
  );

  results.push(
    measure("Plaka siklik anomalisi (kiosk, her islemde calisir)", () => {
      db.prepare("SELECT COUNT(*) as c FROM transactions WHERE station_id = ? AND plate = ? AND created_at >= ?").get(
        pick(),
        "34BM0042",
        iso(0, 0)
      );
    })
  );

  return results;
}

function rowCounts(): Array<{ table: string; rows: number }> {
  const tables = ["transactions", "audit_log", "fuel_tank_readings", "alarms", "stations", "pumps"];
  return tables.map((t) => ({
    table: t,
    rows: db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM ${t}`).get()!.c,
  }));
}

function report(measurements: Measurement[]): void {
  const bytes = statSync(BENCH_DB).size;
  const txRows = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM transactions").get()!.c;

  console.log("=".repeat(78));
  console.log(`OLCEK: ${opts.stations} istasyon, ${opts.days} gun, ${opts.txPerStationDay} islem/istasyon/gun`);
  console.log("=".repeat(78));
  console.log("\nSATIR SAYILARI");
  for (const { table, rows } of rowCounts()) {
    console.log(`  ${table.padEnd(22)} ${rows.toLocaleString("tr").padStart(14)}`);
  }
  console.log(`\nVERITABANI BOYUTU: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  islem basina:    ${txRows > 0 ? (bytes / txRows).toFixed(0) : "-"} bayt (tum tablolar dahil)`);

  console.log("\nSORGU SURELERI (ms)");
  console.log(`  ${"sorgu".padEnd(50)} ${"p50".padStart(8)} ${"p95".padStart(8)} ${"max".padStart(8)}`);
  console.log(`  ${"-".repeat(50)} ${"-".repeat(8)} ${"-".repeat(8)} ${"-".repeat(8)}`);
  for (const m of measurements) {
    console.log(
      `  ${m.name.padEnd(50)} ${m.p50.toFixed(2).padStart(8)} ${m.p95.toFixed(2).padStart(8)} ${m.max.toFixed(2).padStart(8)}`
    );
  }

  console.log("\nSORGU PLANLARI (tam tarama = 'SCAN', indeks = 'SEARCH')");
  const plans: Array<[string, string, unknown[]]> = [
    [
      "Rapor ozeti",
      "SELECT COUNT(*) FROM transactions WHERE station_id = ? AND created_at >= ? AND created_at <= ?",
      [1, "2020-01-01", "2030-01-01"],
    ],
    ["Islem listesi", "SELECT * FROM transactions WHERE station_id = ? ORDER BY created_at DESC LIMIT 50", [1]],
    ["Denetim kaydi", "SELECT * FROM audit_log WHERE station_id = ? ORDER BY created_at DESC LIMIT 100", [1]],
    [
      "Sapma gecmisi",
      "SELECT * FROM fuel_tank_readings WHERE station_id = ? AND fuel_type = 'benzin' ORDER BY measured_at DESC LIMIT 50",
      [1],
    ],
    [
      "Konsolide rapor alt sorgusu (is gunu ifadesi)",
      `SELECT COUNT(*) FROM transactions t WHERE t.station_id = ? AND t.status = 'completed'
         AND date(COALESCE(t.completed_at, t.created_at), '+3 hours') BETWEEN ? AND ?`,
      [1, "2020-01-01", "2030-01-01"],
    ],
  ];
  for (const [label, sql, params] of plans) {
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as [])) as Array<{ detail: string }>;
    console.log(`  ${label}:`);
    for (const r of rows) console.log(`      ${r.detail}`);
  }
  console.log("");
}

seed();
report(runQueries());

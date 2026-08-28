import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { StationKioskRow, StationRow, UserRow } from "../db/types.js";
import { attachStationScope, csrfProtection, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { requireStationAccess, stationScopeFilter } from "../middleware/tenantScope.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import { generateStationCode } from "../utils/stationCode.js";
import { randomBytes } from "node:crypto";

const router = Router();
router.use(requireAuth, attachStationScope);

function serializeStation(s: StationRow) {
  return {
    id: s.id,
    slug: s.slug,
    code: s.code,
    tenantId: s.tenant_id,
    requireKioskToken: !!s.require_kiosk_token,
    name: s.name,
    address: s.address,
    contactPhone: s.contact_phone,
    latitude: s.latitude,
    longitude: s.longitude,
    active: !!s.active,
    createdAt: s.created_at,
  };
}

function serializeKiosk(k: StationKioskRow) {
  return {
    id: k.id,
    stationId: k.station_id,
    label: k.label,
    anydeskId: k.anydesk_id,
    // Cihaz tokeni yalnizca super_admin'in gordugu bu uctan doner; kiosk kurulumunda
    // adrese eklenir (bkz. web/src/kiosk/kioskDeviceToken.ts).
    deviceToken: k.device_token,
    // Bagliysa kiosk pompa secme adimini atlar (bkz. routes/kiosk.ts -> boundPumpId).
    pumpId: k.pump_id,
    lastSeenAt: k.last_seen_at,
    createdAt: k.created_at,
  };
}

/**
 * Kiosk'a baglanacak pompanin AYNI istasyona ait oldugunu dogrular. Bu kontrol
 * olmadan bir kiosk baska bir istasyonun pompasina baglanabilir ve o pompayi
 * musteriye hic sormadan otomatik secerdi.
 */
function assertPumpBelongsToStation(pumpId: number | null, stationId: number, res: import("express").Response): boolean {
  if (pumpId == null) return true;
  const pump = db
    .prepare<[number, number], { id: number }>("SELECT id FROM pumps WHERE id = ? AND station_id = ?")
    .get(pumpId, stationId);
  if (!pump) {
    res.status(400).json({ error: "Secilen pompa bu istasyona ait degil." });
    return false;
  }
  return true;
}

router.get("/current", requireStationSelected, (req, res) => {
  const station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(req.stationId!);
  if (!station) return void res.status(404).json({ error: "Istasyon bulunamadi." });
  res.json({ station: serializeStation(station) });
});

const searchQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().positive().max(50).optional(),
});

/**
 * Hafif istasyon aramasi: binlerce istasyon olan bir dagitimda (bkz. Tenants.tsx
 * "Istasyon Ata") tum istasyon listesini (asagidaki GET /'un yaptigi gibi HER istasyon
 * icin 5 ayri istatistik sorgusuyla) tek seferde cekmek yerine, yazildikca (debounce'lu)
 * sunucu tarafinda aranir - istemciye asla binlerce satir gonderilmez. serializeStation
 * disinda EK bir alan hesaplanmaz (pompa/alarm/kullanici sayisi vb.) - bu uc yalnizca
 * bir secim bileseni (combobox) icindir, listeleme/istatistik ekrani degil.
 */
router.get("/search", requireRole("super_admin", "tenant_admin"), validateQuery(searchQuerySchema), (req, res) => {
  const { q, limit } = (req as unknown as { validatedQuery: z.infer<typeof searchQuerySchema> }).validatedQuery;
  const scope = stationScopeFilter(req, "id");
  const take = limit ?? 20;

  let sql = `SELECT * FROM stations WHERE ${scope.sql}`;
  const params: (string | number)[] = [...scope.params];
  if (q) {
    sql += ` AND (name LIKE ? OR code LIKE ? OR slug LIKE ?)`;
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  sql += ` ORDER BY name LIMIT ?`;
  params.push(take);

  const stations = db.prepare<(string | number)[], StationRow>(sql).all(...params);
  res.json({ stations: stations.map(serializeStation) });
});

router.get("/", requireRole("super_admin", "tenant_admin"), (req, res) => {
  // Bu uc tek bir istasyona degil "tum istasyonlarim"a bakar; attachStationScope'un
  // ?stationId= kapisindan gecmez, bu yuzden kiraci filtresini kendisi uygular.
  const scope = stationScopeFilter(req, "id");
  const stations = db
    .prepare<number[], StationRow>(`SELECT * FROM stations WHERE ${scope.sql} ORDER BY name`)
    .all(...scope.params);
  const withStats = stations.map((s) => {
    const pumpCount = (db.prepare("SELECT COUNT(*) as c FROM pumps WHERE station_id = ?").get(s.id) as { c: number }).c;
    const activeAlarms = (
      db.prepare("SELECT COUNT(*) as c FROM alarms WHERE station_id = ? AND status = 'active'").get(s.id) as { c: number }
    ).c;
    const userCount = (db.prepare("SELECT COUNT(*) as c FROM users WHERE station_id = ?").get(s.id) as { c: number }).c;
    const transactionCount = (db.prepare("SELECT COUNT(*) as c FROM transactions WHERE station_id = ?").get(s.id) as { c: number }).c;
    const syncState = db
      .prepare<[number], { last_heartbeat_at: string | null; last_synced_at: string | null }>(
        "SELECT last_heartbeat_at, last_synced_at FROM station_sync_state WHERE station_id = ?"
      )
      .get(s.id);
    return {
      ...serializeStation(s),
      pumpCount,
      activeAlarms,
      userCount,
      transactionCount,
      lastHeartbeatAt: syncState?.last_heartbeat_at ?? null,
      lastSyncedAt: syncState?.last_synced_at ?? null,
      agentConfigured: syncState !== undefined,
    };
  });
  res.json({ stations: withStats });
});

const createSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]{2,40}$/, "Slug yalnizca kucuk harf, rakam ve tire icerebilir (orn: merkez-istasyon)."),
  name: z.string().min(2).max(120),
  address: z.string().max(300).optional().default(""),
  contactPhone: z.string().trim().max(40).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  pumpCount: z.number().int().min(1).max(16).optional().default(4),
});

const PUMP_POSITIONS = [
  { x: 20, y: 30 }, { x: 45, y: 30 }, { x: 20, y: 65 }, { x: 45, y: 65 },
  { x: 70, y: 30 }, { x: 70, y: 65 }, { x: 95, y: 30 }, { x: 95, y: 65 },
];

const DEFAULT_FUEL_PRICES = [
  { fuelType: "benzin", label: "Kursunsuz Benzin 95", price: 44.5 },
  { fuelType: "motorin", label: "Motorin (Diesel)", price: 43.2 },
  { fuelType: "lpg", label: "Otogaz LPG", price: 21.9 },
];

const DEFAULT_FUEL_TANKS = [
  { fuelType: "benzin", capacity: 10000, current: 0, threshold: 1500 },
  { fuelType: "motorin", capacity: 10000, current: 0, threshold: 1500 },
  { fuelType: "lpg", capacity: 5000, current: 0, threshold: 750 },
];

router.post("/", requireRole("super_admin"), csrfProtection, validateBody(createSchema), (req, res) => {
  const body = req.body as z.infer<typeof createSchema>;

  const existing = db.prepare("SELECT id FROM stations WHERE slug = ?").get(body.slug);
  if (existing) return void res.status(409).json({ error: "Bu slug zaten kullaniliyor." });

  const create = db.transaction(() => {
    const code = generateStationCode((c) => !!db.prepare("SELECT 1 FROM stations WHERE code = ?").get(c));
    const result = db
      .prepare("INSERT INTO stations (slug, code, name, address, contact_phone, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(body.slug, code, body.name, body.address, body.contactPhone || null, body.latitude ?? null, body.longitude ?? null);
    const stationId = result.lastInsertRowid as number;

    const insertPrice = db.prepare(
      "INSERT INTO fuel_prices (station_id, fuel_type, label, price_per_liter) VALUES (?, ?, ?, ?)"
    );
    for (const p of DEFAULT_FUEL_PRICES) insertPrice.run(stationId, p.fuelType, p.label, p.price);

    const insertPump = db.prepare(
      `INSERT INTO pumps (station_id, number, label, status, fuel_types, pos_x, pos_y) VALUES (?, ?, ?, 'idle', ?, ?, ?)`
    );
    for (let i = 0; i < body.pumpCount; i++) {
      const pos = PUMP_POSITIONS[i % PUMP_POSITIONS.length]!;
      insertPump.run(stationId, i + 1, `Pompa ${i + 1}`, JSON.stringify(["benzin", "motorin", "lpg"]), pos.x, pos.y);
    }

    const insertTank = db.prepare(
      "INSERT INTO fuel_tanks (station_id, fuel_type, capacity_liters, current_liters, low_stock_threshold_liters) VALUES (?, ?, ?, ?, ?)"
    );
    for (const t of DEFAULT_FUEL_TANKS) insertTank.run(stationId, t.fuelType, t.capacity, t.current, t.threshold);

    return stationId;
  });

  const stationId = create();

  recordAudit({
    user: req.user!,
    action: "station_created",
    entityType: "station",
    entityId: stationId,
    details: { slug: body.slug, name: body.name, pumpCount: body.pumpCount },
    ip: req.ip,
    stationId,
  });

  const station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(stationId)!;
  res.status(201).json({ station: serializeStation(station) });
});

const updateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  requireKioskToken: z.boolean().optional(),
  address: z.string().max(300).optional(),
  contactPhone: z.string().trim().max(40).nullable().optional(),
  active: z.boolean().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
});

router.patch("/:id", requireRole("super_admin", "tenant_admin"), csrfProtection, validateBody(updateSchema), (req, res) => {
  const id = Number(req.params.id);
  if (!requireStationAccess(req, res, id)) return;
  const existing = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(id);
  if (!existing) return void res.status(404).json({ error: "Istasyon bulunamadi." });

  const body = req.body as z.infer<typeof updateSchema>;
  const fields: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) { fields.push("name = ?"); values.push(body.name); }
  if (body.address !== undefined) { fields.push("address = ?"); values.push(body.address); }
  if (body.contactPhone !== undefined) { fields.push("contact_phone = ?"); values.push(body.contactPhone || null); }
  if (body.active !== undefined) { fields.push("active = ?"); values.push(body.active ? 1 : 0); }
  if (body.latitude !== undefined) { fields.push("latitude = ?"); values.push(body.latitude); }
  if (body.longitude !== undefined) { fields.push("longitude = ?"); values.push(body.longitude); }
  if (body.requireKioskToken !== undefined) { fields.push("require_kiosk_token = ?"); values.push(body.requireKioskToken ? 1 : 0); }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE stations SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    recordAudit({ user: req.user!, action: "station_updated", entityType: "station", entityId: id, details: body, ip: req.ip, stationId: id });
  }

  const updated = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(id)!;
  res.json({ station: serializeStation(updated) });
});

router.delete("/:id", requireRole("super_admin"), csrfProtection, (req, res) => {
  const id = Number(req.params.id);
  const station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(id);
  if (!station) return void res.status(404).json({ error: "Istasyon bulunamadi." });

  const txCount = (db.prepare("SELECT COUNT(*) as c FROM transactions WHERE station_id = ?").get(id) as { c: number }).c;
  if (txCount > 0) {
    res.status(409).json({
      error: "Bu istasyonda islem kayitlari oldugu icin tamamen silinemez. Bunun yerine devre disi birakabilirsiniz.",
    });
    return;
  }

  const stationUsers = db.prepare<[number], UserRow>("SELECT * FROM users WHERE station_id = ?").all(id);

  const del = db.transaction(() => {
    db.prepare("DELETE FROM alarms WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM shifts WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM pumps WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM fuel_prices WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM fuel_stock_movements WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM fuel_tanks WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM settings WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM station_sync_events WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM station_sync_state WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM station_kiosks WHERE station_id = ?").run(id);

    // Istasyona bagli kullanici hesaplarini da kalici olarak sil (islem kaydi
    // olmadigi icin bu hesaplarin baska bir istasyona tasinmasi anlamsiz).
    // Denetim gunlugundeki gecmis kayitlari koru, sadece kullaniciya olan referansi kaldir.
    if (stationUsers.length > 0) {
      const userIds = stationUsers.map((u) => u.id);
      const placeholders = userIds.map(() => "?").join(",");
      db.prepare(`UPDATE audit_log SET user_id = NULL WHERE user_id IN (${placeholders})`).run(...userIds);
      db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...userIds);
    }

    // Denetim gunlugundeki gecmis kayitlari koru, sadece bu istasyona olan referansi kaldir.
    db.prepare("UPDATE audit_log SET station_id = NULL WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM stations WHERE id = ?").run(id);
  });
  del();

  recordAudit({
    user: req.user!,
    action: "station_deleted",
    entityType: "station",
    entityId: id,
    details: { slug: station.slug, name: station.name, deletedUsernames: stationUsers.map((u) => u.username) },
    ip: req.ip,
    stationId: null,
  });

  res.status(204).end();
});

/**
 * Bir istasyonda genelde TEK degil, pompa/ada basina AYRI bir fiziksel kiosk PC'si
 * olur - bu ucler, uzak masaustu erisimi (AnyDesk vb.) icin her birinin kimligini
 * serbest bir etiketle (ör. "Pompa 1-2 Adasi") eslestiren kucuk bir not defteridir.
 * Canli kiosk web akisiyla (musterinin pompa secme adimi) hicbir iliskisi yoktur -
 * salt personelin dogru fiziksel makineye baglanmasini kolaylastirir.
 */
function getStationOr404(id: number, res: import("express").Response): StationRow | null {
  const station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(id);
  if (!station) res.status(404).json({ error: "Istasyon bulunamadi." });
  return station ?? null;
}

router.get("/:stationId/kiosks", requireRole("super_admin", "tenant_admin"), (req, res) => {
  const stationId = Number(req.params.stationId);
  if (!requireStationAccess(req, res, stationId)) return;
  if (!getStationOr404(stationId, res)) return;
  const kiosks = db
    .prepare<[number], StationKioskRow>("SELECT * FROM station_kiosks WHERE station_id = ? ORDER BY id ASC")
    .all(stationId);
  res.json({ kiosks: kiosks.map(serializeKiosk) });
});

const kioskSchema = z.object({
  label: z.string().trim().min(1).max(80),
  anydeskId: z.string().trim().max(60).nullable().optional(),
  pumpId: z.number().int().positive().nullable().optional(),
});

router.post("/:stationId/kiosks", requireRole("super_admin", "tenant_admin"), csrfProtection, validateBody(kioskSchema), (req, res) => {
  const stationId = Number(req.params.stationId);
  if (!requireStationAccess(req, res, stationId)) return;
  if (!getStationOr404(stationId, res)) return;
  const body = req.body as z.infer<typeof kioskSchema>;
  if (!assertPumpBelongsToStation(body.pumpId ?? null, stationId, res)) return;
  // Her fiziksel kiosk kendi cihaz tokeniyle olusturulur; kiosk uygulamasi bunu
  // gonderdiginde istek bu istasyona sabitlenir (bkz. middleware/kioskDevice.ts).
  const deviceToken = randomBytes(32).toString("hex");
  const result = db
    .prepare("INSERT INTO station_kiosks (station_id, label, anydesk_id, device_token, pump_id) VALUES (?, ?, ?, ?, ?)")
    .run(stationId, body.label, body.anydeskId ?? null, deviceToken, body.pumpId ?? null);
  const kiosk = db.prepare<[number], StationKioskRow>("SELECT * FROM station_kiosks WHERE id = ?").get(result.lastInsertRowid as number)!;
  recordAudit({
    user: req.user!,
    action: "station_kiosk_created",
    entityType: "station_kiosk",
    entityId: kiosk.id,
    details: { label: kiosk.label },
    ip: req.ip,
    stationId,
  });
  res.status(201).json({ kiosk: serializeKiosk(kiosk) });
});

const kioskUpdateSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  anydeskId: z.string().trim().max(60).nullable().optional(),
  pumpId: z.number().int().positive().nullable().optional(),
});

router.patch(
  "/:stationId/kiosks/:kioskId",
  requireRole("super_admin", "tenant_admin"),
  csrfProtection,
  validateBody(kioskUpdateSchema),
  (req, res) => {
    const stationId = Number(req.params.stationId);
    if (!requireStationAccess(req, res, stationId)) return;
    const kioskId = Number(req.params.kioskId);
    const existing = db
      .prepare<[number, number], StationKioskRow>("SELECT * FROM station_kiosks WHERE id = ? AND station_id = ?")
      .get(kioskId, stationId);
    if (!existing) return void res.status(404).json({ error: "Kiosk kaydi bulunamadi." });

    const body = req.body as z.infer<typeof kioskUpdateSchema>;
    if (body.pumpId !== undefined && !assertPumpBelongsToStation(body.pumpId, stationId, res)) return;
    const fields: string[] = [];
    const values: unknown[] = [];
    if (body.label !== undefined) { fields.push("label = ?"); values.push(body.label); }
    if (body.anydeskId !== undefined) { fields.push("anydesk_id = ?"); values.push(body.anydeskId); }
    if (body.pumpId !== undefined) { fields.push("pump_id = ?"); values.push(body.pumpId); }

    if (fields.length > 0) {
      values.push(kioskId);
      db.prepare(`UPDATE station_kiosks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      recordAudit({
        user: req.user!,
        action: "station_kiosk_updated",
        entityType: "station_kiosk",
        entityId: kioskId,
        details: body,
        ip: req.ip,
        stationId,
      });
    }

    const updated = db.prepare<[number], StationKioskRow>("SELECT * FROM station_kiosks WHERE id = ?").get(kioskId)!;
    res.json({ kiosk: serializeKiosk(updated) });
  }
);

router.delete("/:stationId/kiosks/:kioskId", requireRole("super_admin", "tenant_admin"), csrfProtection, (req, res) => {
  const stationId = Number(req.params.stationId);
  if (!requireStationAccess(req, res, stationId)) return;
  const kioskId = Number(req.params.kioskId);
  const existing = db
    .prepare<[number, number], StationKioskRow>("SELECT * FROM station_kiosks WHERE id = ? AND station_id = ?")
    .get(kioskId, stationId);
  if (!existing) return void res.status(404).json({ error: "Kiosk kaydi bulunamadi." });

  db.prepare("DELETE FROM station_kiosks WHERE id = ?").run(kioskId);
  recordAudit({
    user: req.user!,
    action: "station_kiosk_deleted",
    entityType: "station_kiosk",
    entityId: kioskId,
    details: { label: existing.label },
    ip: req.ip,
    stationId,
  });
  res.status(204).end();
});

export { router as stationsRouter };

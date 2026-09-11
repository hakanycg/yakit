import { createHash } from "node:crypto";
import { db } from "../db/index.js";
import type { AuditLogRow, UserRow } from "../db/types.js";
import { currentRequestContext } from "../middleware/requestContext.js";

/**
 * Hash-chain (tahrif tespiti): her denetim kaydi, kendi alanlarinin VE bir onceki
 * (canli tablodaki en son) kaydin hash'inin sha256'sini tasir. Sonradan bir kaydin
 * herhangi bir alani degistirilirse o kaydin hash'i artik tutmaz; bir kayit araya
 * sokulur veya silinirse zincirdeki komsulugu (prev_hash <-> hash) bozulur - ikisi de
 * verifyAuditChain() ile tespit edilir.
 *
 * Arsivleme (bkz. archiveService.ts) eski kayitlari canli tablodan TASIDIGI icin zincirin
 * "gecmise dogru" ilk halkasi (en eski canli satirin prev_hash'i) dogrulanamaz - bu
 * beklenen bir durum, kasit degil. verifyAuditChain bu yuzden "genesis"e degil, canli
 * tablodaki EN ESKI satirin kendi prev_hash'ine ceviri yapar ve yalnizca ONDAN SONRAKI
 * komsulugu dogrular.
 */
function computeAuditHash(
  prevHash: string,
  row: {
    station_id: number | null;
    user_id: number | null;
    username: string | null;
    actor_type: string | null;
    role: string | null;
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    details: string | null;
    ip_address: string | null;
    user_agent: string | null;
    created_at: string;
  }
): string {
  const payload = JSON.stringify([
    prevHash,
    row.station_id,
    row.user_id,
    row.username,
    row.actor_type,
    row.role,
    row.action,
    row.entity_type,
    row.entity_id,
    row.details,
    row.ip_address,
    row.user_agent,
    row.created_at,
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

const GENESIS_HASH = "0".repeat(64);

function lastAuditHash(): string {
  const row = db.prepare<[], { hash: string | null }>("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get();
  return row?.hash ?? GENESIS_HASH;
}

/**
 * Denetim kaydini kimin actigi. Personel oturumu OLMAYAN islemler de bir aktore
 * sahiptir - "bos" degil: filo portali musterisi, zamanlanmis bir is, ya da henuz
 * kimligi dogrulanmamis biri (basarisiz giris denemesi). Bunlarin hepsini NULL
 * kullanici adiyla kaydetmek, logu okuyan kisiye "kim yapti?" sorusunun cevabini
 * hic vermiyordu.
 */
export type AuditActorType = "staff" | "fleet_portal" | "system" | "anonymous";

const ACTOR_FALLBACK_LABEL: Record<AuditActorType, string> = {
  staff: "bilinmeyen kullanıcı",
  fleet_portal: "filo portalı",
  system: "sistem",
  anonymous: "kimliği doğrulanmamış",
};

export function recordAudit(params: {
  user: UserRow | null;
  action: string;
  entityType?: string;
  entityId?: string | number;
  details?: unknown;
  /** Verilmezse istek baglamindan (AsyncLocalStorage) alinir. */
  ip?: string;
  stationId?: number | null;
  /** Personel oturumu yoksa kaydi kimin actigi. Varsayilan: sistem. */
  actorType?: AuditActorType;
  /** Personel oturumu yoksa gorunecek ad (ör. filo portali e-postasi, denenen kullanici adi). */
  actorLabel?: string;
}): void {
  const stationId = params.stationId !== undefined ? params.stationId : (params.user?.station_id ?? null);
  const context = currentRequestContext();
  const actorType: AuditActorType = params.user ? "staff" : (params.actorType ?? "system");
  // Kullanici adi asla bos kalmaz: personel varsa kendi adi, yoksa aktorun etiketi,
  // o da yoksa aktor turunun okunabilir karsiligi yazilir.
  const username = params.user?.username ?? params.actorLabel ?? ACTOR_FALLBACK_LABEL[actorType];

  const row = {
    station_id: stationId,
    user_id: params.user?.id ?? null,
    username,
    actor_type: actorType,
    role: params.user ? roleNameFor(params.user.role_id) : null,
    action: params.action,
    entity_type: params.entityType ?? null,
    entity_id: params.entityId !== undefined ? String(params.entityId) : null,
    details: params.details !== undefined ? JSON.stringify(params.details) : null,
    ip_address: params.ip ?? context?.ip ?? null,
    user_agent: context?.userAgent ?? null,
    created_at: new Date().toISOString(),
  };
  // Zincirdeki bir sonraki halka: bir onceki kaydin hash'i okunup hemen kullanilir. Tek
  // Node sureci icinde (canli sunucunun calisma sekli) bu tek basina yeterlidir - better-sqlite3
  // senkron oldugundan iki recordAudit cagrisi arasina baska JS kodu giremez. Ama "oku, sonra
  // yaz" adimi yine de TEK bir db.transaction() icine alinir: SQLite (WAL modunda) yazma
  // kilidini transaction suresince tutar, boylece bu veritabani dosyasina AYNI ANDA baska
  // bir SURECTEN (ör. bir bakim script'i, ya da bu test takiminin coklu is parcaciginda
  // PARALEL calisan test dosyalari) erisilse bile iki kaydin ayni prevHash'i okuyup
  // zincirde catallanma yaratmasi engellenir.
  const insert = db.prepare(
    `INSERT INTO audit_log
       (station_id, user_id, username, actor_type, role, action, entity_type, entity_id, details, ip_address, user_agent, created_at, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    const prevHash = lastAuditHash();
    const hash = computeAuditHash(prevHash, row);
    insert.run(
      row.station_id,
      row.user_id,
      row.username,
      row.actor_type,
      row.role,
      row.action,
      row.entity_type,
      row.entity_id,
      row.details,
      row.ip_address,
      row.user_agent,
      row.created_at,
      prevHash,
      hash
    );
  })();
}

export interface AuditChainVerification {
  ok: boolean;
  checkedCount: number;
  /** Zincir kirikliginin ILK tespit edildigi kaydin id'si (ok=false ise). */
  brokenAtId: number | null;
}

/**
 * Canli audit_log tablosundaki hash zincirinin butunlugunu dogrular. Arsivlenmis
 * (canli tablodan tasinmis) gecmis dogrulanamaz - bkz. dosya basindaki yorum; bu yuzden
 * en eski canli satirin KENDI prev_hash'i sorgulanmaz, sadece ONDAN SONRAKI komsuluklar
 * (prev_hash <-> onceki satirin hash'i) ve her satirin kendi hash'i yeniden hesaplanip
 * karsilastirilir.
 */
export function verifyAuditChain(sinceId?: number): AuditChainVerification {
  // hash IS NOT NULL: bu ozellik yayina alinmadan ONCE yazilmis eski kayitlarin hic
  // hash'i yok (ensureColumn ile eklenen kolon onlarda NULL kalir) - bunlar tahrif
  // degil, sadece dogrulanamaz gecmis; zincir SADECE hash'lenmis kayitlar uzerinden kurulur.
  // sinceId: verilirse yalnizca id >= sinceId olan kayitlar dogrulanir - buyuk bir tabloda
  // periyodik/kismi dogrulama icin (tam tarama her seferinde gerekmez) ve testlerin
  // yalnizca KENDI ekledigi kayitlara odaklanabilmesi icin kullanislidir.
  const rows =
    sinceId === undefined
      ? db.prepare<[], AuditLogRow>("SELECT * FROM audit_log WHERE hash IS NOT NULL ORDER BY id ASC").all()
      : db.prepare<[number], AuditLogRow>("SELECT * FROM audit_log WHERE hash IS NOT NULL AND id >= ? ORDER BY id ASC").all(sinceId);
  if (rows.length === 0) return { ok: true, checkedCount: 0, brokenAtId: null };

  let expectedPrevHash = rows[0]!.prev_hash;
  for (const r of rows) {
    if (r.prev_hash !== expectedPrevHash) return { ok: false, checkedCount: rows.length, brokenAtId: r.id };
    const recomputed = computeAuditHash(expectedPrevHash ?? GENESIS_HASH, r);
    if (r.hash !== recomputed) return { ok: false, checkedCount: rows.length, brokenAtId: r.id };
    expectedPrevHash = r.hash;
  }
  return { ok: true, checkedCount: rows.length, brokenAtId: null };
}

/**
 * Rol adi kaydin ICINE yaziliyor, sonradan users tablosundan cozulmuyor: bir kullanicinin
 * rolu degistiginde gecmis kayitlarin "o an hangi yetkiyle yapildigi" bilgisi degismemeli.
 */
function roleNameFor(roleId: number): string | null {
  const row = db.prepare<[number], { name: string }>("SELECT name FROM roles WHERE id = ?").get(roleId);
  return row?.name ?? null;
}

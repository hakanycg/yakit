import { db } from "../db/index.js";
import type { UserRow } from "../db/types.js";
import { currentRequestContext } from "../middleware/requestContext.js";

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

  db.prepare(
    `INSERT INTO audit_log
       (station_id, user_id, username, actor_type, role, action, entity_type, entity_id, details, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    stationId,
    params.user?.id ?? null,
    username,
    actorType,
    params.user ? roleNameFor(params.user.role_id) : null,
    params.action,
    params.entityType ?? null,
    params.entityId !== undefined ? String(params.entityId) : null,
    params.details !== undefined ? JSON.stringify(params.details) : null,
    params.ip ?? context?.ip ?? null,
    context?.userAgent ?? null
  );
}

/**
 * Rol adi kaydin ICINE yaziliyor, sonradan users tablosundan cozulmuyor: bir kullanicinin
 * rolu degistiginde gecmis kayitlarin "o an hangi yetkiyle yapildigi" bilgisi degismemeli.
 */
function roleNameFor(roleId: number): string | null {
  const row = db.prepare<[number], { name: string }>("SELECT name FROM roles WHERE id = ?").get(roleId);
  return row?.name ?? null;
}

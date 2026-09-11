import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import { recordAudit, verifyAuditChain } from "./auditService.js";

/**
 * Denetim kaydi "kim, ne zaman, nereden, hangi yetkiyle" sorusunun tek cevabidir;
 * KVKK ve ic denetim buna dayanir. Bos kalan bir alan, cevaplanamayan bir soru demektir.
 */

interface AuditRow {
  id: number;
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
}

let station: StationRow;
let staff: UserRow;

function lastAudit(action: string): AuditRow {
  return db.prepare<[string], AuditRow>("SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1").get(action)!;
}

beforeEach(() => {
  station = createTestStation();
  staff = createTestUser(station.id, "admin");
});

describe("denetim kaydi aktoru", () => {
  it("personel islemi kullanici adini ve ROLU kaydin icine yazar", () => {
    recordAudit({ user: staff, action: "test_staff_action", ip: "10.0.0.1", stationId: station.id });

    const row = lastAudit("test_staff_action");
    expect(row.user_id).toBe(staff.id);
    expect(row.username).toBe(staff.username);
    expect(row.actor_type).toBe("staff");
    // Rol kaydin ICINE yazilir: kullanicinin rolu sonradan degisirse gecmis kayitlarin
    // "o an hangi yetkiyle yapildigi" bilgisi degismemeli.
    expect(row.role).toBe("admin");
  });

  it("rol degisimi GECMIS kayitlari degistirmez", () => {
    recordAudit({ user: staff, action: "test_role_freeze", stationId: station.id });
    const operatorRoleId = db.prepare<[], { id: number }>("SELECT id FROM roles WHERE name = 'operator'").get()!.id;
    db.prepare("UPDATE users SET role_id = ? WHERE id = ?").run(operatorRoleId, staff.id);

    expect(lastAudit("test_role_freeze").role).toBe("admin");
  });

  it("personel oturumu yokken kullanici adi ASLA bos kalmaz", () => {
    // Bu tam olarak duzeltilen hataydi: filo portali/sistem/anonim islemler
    // denetim kaydinda bos kullanici adiyla goruunuyordu.
    recordAudit({ user: null, actorType: "fleet_portal", actorLabel: "filo@ornek.com", action: "test_portal_action" });
    expect(lastAudit("test_portal_action").username).toBe("filo@ornek.com");

    recordAudit({ user: null, actorType: "system", action: "test_system_action" });
    expect(lastAudit("test_system_action").username).toBeTruthy();

    recordAudit({ user: null, actorType: "anonymous", action: "test_anon_action" });
    expect(lastAudit("test_anon_action").username).toBeTruthy();
  });

  it("aktor turu belirtilmemis, kullanicisi da olmayan kayit 'system' sayilir", () => {
    recordAudit({ user: null, action: "test_default_actor" });
    expect(lastAudit("test_default_actor").actor_type).toBe("system");
  });

  it("kullanici verilmisse actorType gormezden gelinir - personel personeldir", () => {
    recordAudit({ user: staff, actorType: "anonymous", action: "test_actor_override" });
    expect(lastAudit("test_actor_override").actor_type).toBe("staff");
  });
});

describe("denetim kaydi icerigi", () => {
  it("varlik ve detay alanlari saklanir", () => {
    recordAudit({
      user: staff,
      action: "test_details",
      entityType: "fleet_account",
      entityId: 42,
      details: { amount: 1500, note: "test" },
      stationId: station.id,
    });

    const row = lastAudit("test_details");
    expect(row.entity_type).toBe("fleet_account");
    expect(row.entity_id).toBe("42");
    expect(JSON.parse(row.details!)).toEqual({ amount: 1500, note: "test" });
  });

  it("detay verilmezse NULL kalir - bos bir JSON nesnesi yazilmaz", () => {
    recordAudit({ user: staff, action: "test_no_details", stationId: station.id });
    expect(lastAudit("test_no_details").details).toBeNull();
  });

  it("istasyon verilmezse kullanicinin istasyonundan turetilir", () => {
    recordAudit({ user: staff, action: "test_station_inherited" });
    expect(lastAudit("test_station_inherited").station_id).toBe(station.id);
  });

  it("acikca null verilen istasyon KORUNUR - platform geneli islemler bir istasyona yazilmaz", () => {
    recordAudit({ user: staff, action: "test_station_null", stationId: null });
    expect(lastAudit("test_station_null").station_id).toBeNull();
  });

  it("IP adresi kaydedilir", () => {
    recordAudit({ user: staff, action: "test_ip", ip: "203.0.113.9", stationId: station.id });
    expect(lastAudit("test_ip").ip_address).toBe("203.0.113.9");
  });
});

/**
 * Hash-chain (tahrif tespiti - bkz. auditService.ts basindaki yorum). audit_log tum test
 * dosyalari arasinda PAYLASILAN global bir tablo oldugundan (bkz. yukaridaki testlerin
 * kendi action adiyla filtreleme deseni), butunluk testleri de BASKA hicbir testin
 * yapmadigi bir seyi (tabloyu KASITLI olarak bozmayi) yalnizca KENDI ekledigi satira
 * uygular - boylece paralel calisan diger test dosyalarini etkilemez/onlardan etkilenmez.
 */
describe("denetim kaydi hash-chain (tahrif tespiti)", () => {
  it("her kayit 64 haneli hex hash/prev_hash ile saklanir", () => {
    recordAudit({ user: staff, action: "test_chain_fields", stationId: station.id });
    const row = lastAudit("test_chain_fields") as AuditRow & { hash: string; prev_hash: string };
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.prev_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ardisik iki kayit zincirlenir: ikincinin prev_hash'i birincinin hash'idir", () => {
    recordAudit({ user: staff, action: "test_chain_link_a", stationId: station.id });
    recordAudit({ user: staff, action: "test_chain_link_b", stationId: station.id });
    const a = lastAudit("test_chain_link_a") as AuditRow & { hash: string };
    const b = lastAudit("test_chain_link_b") as AuditRow & { prev_hash: string };
    // Ikisi arasina baska bir test dosyasindan bir kayit sikismis olsa bile (global tablo),
    // b MUTLAKA a'dan SONRA eklendigi icin b.prev_hash zincirde a.hash'ten sonraki
    // (belki araya giren) bir hash olur - dogrudan esitlik yerine zincirin kirilmadigini
    // verifyAuditChain uzerinden dogrulamak daha saglam olurdu, ama pratikte iki
    // recordAudit cagrisi arasinda (await yok, tek is parcaciginda) baska JS calisamaz.
    expect(b.prev_hash).toBe(a.hash);
  });

  it("bir kaydin alani sonradan degistirilirse verifyAuditChain tahrifi tespit eder", () => {
    recordAudit({ user: staff, action: "test_chain_tamper", stationId: station.id });
    const row = lastAudit("test_chain_tamper");

    db.prepare("UPDATE audit_log SET action = 'tampered_action' WHERE id = ?").run(row.id);
    try {
      // sinceId=row.id: audit_log paralel calisan diger test dosyalariyla PAYLASILAN
      // global bir tablo - tam tablo taramasi (sinceId verilmeden) o an baska bir
      // surecin/is parcaciginin ekledigi ALAKASIZ kayitlari da isaret edebilir. Bu test
      // yalnizca KENDI bozdugu kaydin tespit edildigini dogrular.
      const result = verifyAuditChain(row.id);
      expect(result.ok).toBe(false);
      expect(result.brokenAtId).toBe(row.id);
    } finally {
      // Global tabloyu diger testler (ve bu dosyadaki sonraki testler) icin bozuk
      // birakmamak icin geri al - tahrif SADECE bu testin kontrollu senaryosunda var olmali.
      db.prepare("UPDATE audit_log SET action = ? WHERE id = ?").run(row.action, row.id);
    }
  });

  it("tahrif yoksa zincir gecerli sayilir", () => {
    recordAudit({ user: staff, action: "test_chain_valid", stationId: station.id });
    const row = lastAudit("test_chain_valid");
    // Ayni gerekce: sadece bu testin kendi kaydindan itibaren dogrulanir (bkz. yukaridaki test).
    const result = verifyAuditChain(row.id);
    expect(result.ok).toBe(true);
    expect(result.checkedCount).toBeGreaterThan(0);
  });
});

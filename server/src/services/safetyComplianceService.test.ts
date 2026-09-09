import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import {
  SAFETY_COMPLIANCE_ITEMS,
  SafetyComplianceError,
  checkExpiringCompliance,
  getStationComplianceStatus,
  listCompliance,
  recordCompliance,
} from "./safetyComplianceService.js";

let station: StationRow;
let actor: UserRow;
const DAY = 86400000;

function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * DAY).toISOString();
}

function activeAlarms(type: string): { message: string; severity: string }[] {
  return db
    .prepare<[number, string], { message: string; severity: string }>(
      "SELECT message, severity FROM alarms WHERE station_id = ? AND type = ? AND status != 'resolved'"
    )
    .all(station.id, type);
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
});

describe("kayit", () => {
  it("kalemin varsayilan araligiyla vadeyi hesaplar", () => {
    const r = recordCompliance(station.id, { itemType: "fire_extinguisher", completedAt: daysAgoIso(0) }, actor);

    expect(r.interval_months).toBe(6);
    const expectedDue = new Date(r.completed_at);
    expectedDue.setUTCMonth(expectedDue.getUTCMonth() + 6);
    expect(new Date(r.next_due_at).getTime()).toBe(expectedDue.getTime());
  });

  it("elle verilen araligi varsayilanin yerine kullanir", () => {
    const r = recordCompliance(
      station.id,
      { itemType: "staff_safety_training", completedAt: daysAgoIso(0), intervalMonths: 3 },
      actor
    );
    expect(r.interval_months).toBe(3);
  });

  it("gecersiz kalem tipini reddeder", () => {
    expect(() =>
      // @ts-expect-error kasitli gecersiz deger
      recordCompliance(station.id, { itemType: "yok_boyle_bir_sey", completedAt: daysAgoIso(0) }, actor)
    ).toThrow(SafetyComplianceError);
  });

  it("araligin 1-120 ay disinda olmasini reddeder", () => {
    expect(() =>
      recordCompliance(station.id, { itemType: "fire_extinguisher", completedAt: daysAgoIso(0), intervalMonths: 0 }, actor)
    ).toThrow(SafetyComplianceError);
    expect(() =>
      recordCompliance(station.id, { itemType: "fire_extinguisher", completedAt: daysAgoIso(0), intervalMonths: 121 }, actor)
    ).toThrow(SafetyComplianceError);
  });

  it("tum sabit kalemler icin tanimli ve benzersiz tip", () => {
    const types = new Set(SAFETY_COMPLIANCE_ITEMS.map((i) => i.type));
    expect(types.size).toBe(SAFETY_COMPLIANCE_ITEMS.length);
  });

  it("listCompliance yalnizca o istasyon+kalemin kayitlarini, en yeniden eskiye dondurur", () => {
    recordCompliance(station.id, { itemType: "fire_extinguisher", completedAt: daysAgoIso(200) }, actor);
    recordCompliance(station.id, { itemType: "fire_extinguisher", completedAt: daysAgoIso(0) }, actor);
    recordCompliance(station.id, { itemType: "cathodic_protection", completedAt: daysAgoIso(0) }, actor);

    const rows = listCompliance(station.id, "fire_extinguisher");
    expect(rows).toHaveLength(2);
    expect(new Date(rows[0]!.completed_at).getTime()).toBeGreaterThan(new Date(rows[1]!.completed_at).getTime());
  });
});

describe("istasyon durumu", () => {
  it("hic kaydi olmayan kalemi 'unknown' olarak listeler", () => {
    const statuses = getStationComplianceStatus(station.id);
    expect(statuses).toHaveLength(SAFETY_COMPLIANCE_ITEMS.length);
    for (const s of statuses) {
      expect(s.status).toBe("unknown");
      expect(s.lastCompletedAt).toBeNull();
    }
  });

  it("vadesi uzak olan kalemi 'valid' isaretler", () => {
    recordCompliance(station.id, { itemType: "cathodic_protection", completedAt: daysAgoIso(0) }, actor);
    const s = getStationComplianceStatus(station.id).find((x) => x.itemType === "cathodic_protection")!;
    expect(s.status).toBe("valid");
    expect(s.daysRemaining).toBeGreaterThan(300);
  });

  it("vadesine az kalan kalemi 'expiring' isaretler", () => {
    // 6 aylik aralik, 5.5 ay once yapilmis -> vadeye ~15 gun kaldi.
    recordCompliance(station.id, { itemType: "fire_extinguisher", completedAt: daysAgoIso(165) }, actor);
    const s = getStationComplianceStatus(station.id).find((x) => x.itemType === "fire_extinguisher")!;
    expect(s.status).toBe("expiring");
  });

  it("suresi gecmis kalemi 'expired' isaretler", () => {
    recordCompliance(station.id, { itemType: "fire_extinguisher", completedAt: daysAgoIso(400) }, actor);
    const s = getStationComplianceStatus(station.id).find((x) => x.itemType === "fire_extinguisher")!;
    expect(s.status).toBe("expired");
    expect(s.daysRemaining).toBeLessThan(0);
  });

  it("yalnizca EN SON kaydi dikkate alir", () => {
    recordCompliance(station.id, { itemType: "fire_extinguisher", completedAt: daysAgoIso(400) }, actor);
    recordCompliance(station.id, { itemType: "fire_extinguisher", completedAt: daysAgoIso(0) }, actor);
    const s = getStationComplianceStatus(station.id).find((x) => x.itemType === "fire_extinguisher")!;
    expect(s.status).toBe("valid");
  });
});

describe("uyum taramasi", () => {
  it("suresi gecmis kalem icin KRITIK alarm uretir", () => {
    recordCompliance(station.id, { itemType: "fire_extinguisher", completedAt: daysAgoIso(400) }, actor);
    checkExpiringCompliance();

    const alarms = activeAlarms("safety_compliance_fire_extinguisher");
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.severity).toBe("critical");
    expect(alarms[0]!.message).toContain("DOLDU");
  });

  it("vadesi yaklasan kalem icin UYARI uretir", () => {
    recordCompliance(station.id, { itemType: "fire_extinguisher", completedAt: daysAgoIso(165) }, actor);
    checkExpiringCompliance();

    expect(activeAlarms("safety_compliance_fire_extinguisher")[0]!.severity).toBe("warning");
  });

  it("hic kaydi olmayan kaleme (unknown) alarm uretmez", () => {
    // Ozelligi henuz kullanmaya baslamamis her istasyonu alarma bogmamak icin.
    checkExpiringCompliance();
    expect(activeAlarms("safety_compliance_fire_extinguisher")).toHaveLength(0);
    expect(activeAlarms("safety_compliance_staff_safety_training")).toHaveLength(0);
  });

  it("ayni kalem icin ikinci alarm acmaz", () => {
    recordCompliance(station.id, { itemType: "fire_extinguisher", completedAt: daysAgoIso(400) }, actor);
    checkExpiringCompliance();
    checkExpiringCompliance();

    expect(activeAlarms("safety_compliance_fire_extinguisher")).toHaveLength(1);
  });

  it("kayit yenilenince alarm kendiliginden cozulur", () => {
    recordCompliance(station.id, { itemType: "fire_extinguisher", completedAt: daysAgoIso(400) }, actor);
    checkExpiringCompliance();
    expect(activeAlarms("safety_compliance_fire_extinguisher")).toHaveLength(1);

    recordCompliance(station.id, { itemType: "fire_extinguisher", completedAt: daysAgoIso(0) }, actor);

    expect(activeAlarms("safety_compliance_fire_extinguisher")).toHaveLength(0);
  });

  it("farkli kalemlerin alarmlari birbirinden bagimsizdir", () => {
    recordCompliance(station.id, { itemType: "fire_extinguisher", completedAt: daysAgoIso(400) }, actor);
    recordCompliance(station.id, { itemType: "cathodic_protection", completedAt: daysAgoIso(0) }, actor);
    checkExpiringCompliance();

    expect(activeAlarms("safety_compliance_fire_extinguisher")).toHaveLength(1);
    expect(activeAlarms("safety_compliance_cathodic_protection")).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import type { StationRow, UserRow } from "../db/types.js";
import { createAlarm } from "./alarmService.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import { recordCalibration } from "./pumpCalibrationService.js";
import { recordCompliance } from "./safetyComplianceService.js";
import { buildComplianceReportCsv, buildComplianceReportData, buildComplianceReportPdf } from "./complianceReportService.js";

let station: StationRow;
let actor: UserRow;

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
});

describe("buildComplianceReportData", () => {
  it("istasyonun 3 kaynagini (uyum takvimi, pompa durumu, acik alarmlar) birlestirir", () => {
    const pumpId = createTestPump(station.id);
    recordCompliance(station.id, { itemType: "fire_extinguisher", completedAt: new Date().toISOString() }, actor);
    // Tolerans icinde: kalibrasyonun kendi otomatik alarmini (bkz. pumpCalibrationService.ts
    // recordCalibration) tetiklemesin diye - bu test yalnizca 3 kaynagin birlestigini
    // dogruluyor, kalibrasyon-disinda-alarm senaryosu kendi test dosyasinda zaten kapsanmis.
    recordCalibration(station.id, pumpId, { fuelType: "motorin", referenceLiters: 20, meteredLiters: 20.02 }, actor);
    createAlarm({ stationId: station.id, type: "manual", severity: "warning", message: "Test alarmi" });

    const data = buildComplianceReportData(station);

    expect(data.station.id).toBe(station.id);
    expect(data.compliance.find((c) => c.itemType === "fire_extinguisher")?.status).toBe("valid");
    expect(data.pumps).toHaveLength(1);
    expect(data.pumps[0]!.withinTolerance).toBe(true);
    expect(data.alarms).toHaveLength(1);
    expect(data.alarms[0]!.message).toBe("Test alarmi");
  });

  it("baska istasyonun verisini karistirmaz", () => {
    const other = createTestStation();
    createAlarm({ stationId: other.id, type: "manual", severity: "critical", message: "Baska istasyon" });

    const data = buildComplianceReportData(station);

    expect(data.alarms).toHaveLength(0);
  });
});

describe("buildComplianceReportCsv", () => {
  it("her bolumden en az bir satir uretir ve BOM ile baslar", () => {
    const pumpId = createTestPump(station.id);
    recordCompliance(station.id, { itemType: "cathodic_protection", completedAt: new Date().toISOString() }, actor);
    recordCalibration(station.id, pumpId, { fuelType: "benzin", referenceLiters: 20, meteredLiters: 20.02 }, actor);
    createAlarm({ stationId: station.id, type: "manual", severity: "critical", message: "Kritik durum" });

    const csv = buildComplianceReportCsv(buildComplianceReportData(station));

    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("Emniyet Uyum Takvimi");
    expect(csv).toContain("Pompa Kalibrasyon/Damga");
    expect(csv).toContain("Acik Alarm");
    expect(csv).toContain("Kritik durum");
  });

  it("formul enjeksiyonuna karsi disaridan gelebilecek alarm mesajini kacar", () => {
    // Alarm mesaji serbest metin degil ama ileride disaridan tetiklenebilecek bir
    // deger tasirsa (ör. entegrasyon hata mesaji) CSV'yi acan personelin
    // tablosunda formule donusmemeli - csvEscape() zaten test edilmis olsa da,
    // burada GERCEKTEN kullanildigini dogrular.
    createAlarm({ stationId: station.id, type: "manual", severity: "warning", message: "=HYPERLINK(\"http://kotu.example\")" });

    const csv = buildComplianceReportCsv(buildComplianceReportData(station));

    expect(csv).toContain("'=HYPERLINK");
  });

  it("hic pompa/alarm yokken de Emniyet Uyum Takviminin 6 sabit kalemini (kayitsiz='unknown' dahil) listeler", () => {
    // Bir istasyon ozelligi hic kullanmamis olsa bile denetci raporu "bu kalemler
    // hic kontrol edilmemis" bilgisini GOSTERMELI - eksik satir, eksik veriden farkli.
    const csv = buildComplianceReportCsv(buildComplianceReportData(station));
    const lines = csv.split("\n");
    expect(lines).toHaveLength(7); // baslik + 6 sabit uyum kalemi
    expect(csv).toContain("Kayit yok");
    expect(csv).not.toContain("Pompa Kalibrasyon/Damga");
    expect(csv).not.toContain("Acik Alarm");
  });
});

describe("buildComplianceReportPdf", () => {
  it("gecerli bir PDF buffer'i uretir", async () => {
    recordCompliance(station.id, { itemType: "tank_grounding", completedAt: new Date().toISOString() }, actor);
    const pdf = await buildComplianceReportPdf(buildComplianceReportData(station));

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("hic pompa/alarm/uyum kaydi olmayan bir istasyon icin de patlamaz", async () => {
    const pdf = await buildComplianceReportPdf(buildComplianceReportData(station));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

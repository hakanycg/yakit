import PDFDocument from "pdfkit";
import { getStationCalibrationStatus, MAX_PERMISSIBLE_ERROR_PCT, type PumpCalibrationStatus } from "./pumpCalibrationService.js";
import { getStationComplianceStatus, type SafetyComplianceStatus } from "./safetyComplianceService.js";
import { listAlarms } from "./alarmService.js";
import { getVarianceSummary, type VarianceSummaryRow } from "./fuelVarianceService.js";
import { csvEscape } from "../utils/csv.js";
import type { AlarmRow, StationRow } from "../db/types.js";

/**
 * Uyum Panosu'nun (bkz. web/src/pages/operator/ComplianceDashboard.tsx) PDF/CSV disa
 * aktarimi. Bir denetci ziyaretinde ekrandaki bolumleri (Emniyet Uyum Takvimi, pompa
 * kalibrasyon/damga durumu, acik alarmlar) tek belgede goturebilmek icin - ayri bir
 * veri kaynagi eklemez, yalnizca ekranin aldigi mevcut sorgulari bir araya getirir.
 *
 * Yakit sapma ozeti (TS 12820 madde 4.2.7.4.9 - "gunluk hassas satis ve stok
 * kayitlari... denetleyicilerin incelemesi icin hazir bulundurulmali") ekranin
 * kendisinde degil, Yakit Sapma Takibi sayfasinda goruntuleniyor; denetci raporunun
 * TEK belgede olmasi gerektiginden buraya da eklenir.
 */

export interface ComplianceReportData {
  station: StationRow;
  generatedAt: string;
  compliance: SafetyComplianceStatus[];
  pumps: PumpCalibrationStatus[];
  alarms: AlarmRow[];
  variance: VarianceSummaryRow[];
}

export function buildComplianceReportData(station: StationRow, now = Date.now()): ComplianceReportData {
  return {
    station,
    generatedAt: new Date(now).toISOString(),
    compliance: getStationComplianceStatus(station.id, now),
    pumps: getStationCalibrationStatus(station.id, now),
    alarms: listAlarms(station.id, "active"),
    variance: getVarianceSummary(station.id),
  };
}

const STATUS_LABEL_TR: Record<string, string> = { valid: "Gecerli", expiring: "Yaklasiyor", expired: "Suresi Doldu", unknown: "Kayit yok" };
const SEVERITY_LABEL_TR: Record<string, string> = { info: "Bilgi", warning: "Uyari", critical: "Kritik" };
const FUEL_LABEL_TR: Record<string, string> = { benzin: "Benzin", motorin: "Motorin", lpg: "LPG" };

function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "-";
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("tr-TR");
}

/** Sabit genislikte sutunlar icin hucreyi kirpar/doldurur - pdfkit'in tablo destegi yok, Courier (sabit genislik) fontla hizalaniyor. */
function pad(s: string, width: number): string {
  const truncated = s.length > width ? s.slice(0, width - 1) + "…" : s;
  return truncated.padEnd(width);
}

export function buildComplianceReportPdf(data: ComplianceReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).fillColor("#000").text("Uyum Raporu");
    doc.fontSize(11).fillColor("#555");
    doc.text(data.station.name);
    doc.text(data.station.address);
    doc.text(`Olusturulma: ${fmtDateTime(data.generatedAt)}`);
    doc.moveDown(1);

    function sectionTitle(title: string) {
      doc.moveDown(0.5);
      doc.fontSize(13).fillColor("#000").font("Helvetica-Bold").text(title);
      doc.font("Helvetica");
      doc.moveDown(0.3);
    }

    function tableRow(cells: string[], widths: number[], bold = false) {
      doc.font(bold ? "Courier-Bold" : "Courier").fontSize(9);
      doc.text(cells.map((c, i) => pad(c, widths[i]!)).join(" "));
    }

    // --- Emniyet Uyum Takvimi ---
    sectionTitle("Emniyet Uyum Takvimi");
    const complianceWidths = [30, 22, 12, 12, 12];
    tableRow(["Kalem", "Madde", "Durum", "Son Kntrl", "Sira. Vade"], complianceWidths, true);
    for (const c of data.compliance) {
      tableRow([c.label, c.standardClause, STATUS_LABEL_TR[c.status] ?? c.status, fmtDate(c.lastCompletedAt), fmtDate(c.nextDueAt)], complianceWidths);
    }

    // --- Pompa Kalibrasyon / Damga ---
    sectionTitle("Pompa Kalibrasyon / Damga");
    const pumpWidths = [10, 18, 18, 12];
    tableRow(["Pompa", "Ayar Durumu", "Damga", "Son Test"], pumpWidths, true);
    for (const p of data.pumps) {
      const calib = p.withinTolerance === null ? "Test edilmedi" : p.withinTolerance ? "Tolerans icinde" : `TOLERANS DISI (>${MAX_PERMISSIBLE_ERROR_PCT}%)`;
      tableRow([`Pompa ${p.pumpNumber}`, calib, STATUS_LABEL_TR[p.sealStatus] ?? p.sealStatus, fmtDate(p.lastTestedAt)], pumpWidths);
    }
    if (data.pumps.length === 0) tableRow(["Kayitli pompa yok."], [60]);

    // --- Acik Alarmlar ---
    sectionTitle("Acik Alarmlar");
    if (data.alarms.length === 0) {
      tableRow(["Acik alarm yok."], [60]);
    } else {
      const alarmWidths = [8, 52, 15];
      tableRow(["Onem", "Mesaj", "Acildi"], alarmWidths, true);
      for (const a of data.alarms) {
        tableRow([SEVERITY_LABEL_TR[a.severity] ?? a.severity, a.message, fmtDateTime(a.created_at)], alarmWidths);
      }
    }

    // --- Gunluk Stok Mutabakati (TS 12820 madde 4.2.7.4.9) ---
    sectionTitle("Yakit Sapma / Stok Mutabakati (madde 4.2.7.4.9)");
    if (data.variance.length === 0) {
      tableRow(["Henuz olcum kaydi yok."], [60]);
    } else {
      const varianceWidths = [10, 10, 14, 16, 12, 14];
      tableRow(["Yakit", "Olcum", "Top. Sapma (L)", "Top. Akis (L)", "Net %", "Son Olcum"], varianceWidths, true);
      for (const v of data.variance) {
        tableRow(
          [
            FUEL_LABEL_TR[v.fuelType] ?? v.fuelType,
            String(v.readingCount),
            v.totalVarianceLiters.toFixed(2),
            v.totalThroughputLiters.toFixed(2),
            `%${v.netVariancePct.toFixed(2)}`,
            fmtDate(v.lastMeasuredAt),
          ],
          varianceWidths
        );
      }
    }

    doc.moveDown(1.5);
    doc.font("Helvetica").fontSize(8).fillColor("#999").text("Bu rapor Uyum Panosu ekraninin olusturuldugu andaki durumunu yansitir.", { align: "center" });

    doc.end();
  });
}

export function buildComplianceReportCsv(data: ComplianceReportData): string {
  const lines: string[] = [];

  lines.push("Bolum,Kalem/Pompa/Onem,Madde/Ayar Durumu/Mesaj,Durum/Damga,Son Kontrol/Test,Siradaki Vade,Acildi");

  for (const c of data.compliance) {
    lines.push(
      ["Emniyet Uyum Takvimi", c.label, c.standardClause, STATUS_LABEL_TR[c.status] ?? c.status, fmtDate(c.lastCompletedAt), fmtDate(c.nextDueAt), ""]
        .map(csvEscape)
        .join(",")
    );
  }

  for (const p of data.pumps) {
    const calib = p.withinTolerance === null ? "Test edilmedi" : p.withinTolerance ? "Tolerans icinde" : "Tolerans disi";
    lines.push(
      ["Pompa Kalibrasyon/Damga", `Pompa ${p.pumpNumber}`, calib, STATUS_LABEL_TR[p.sealStatus] ?? p.sealStatus, fmtDate(p.lastTestedAt), "", ""]
        .map(csvEscape)
        .join(",")
    );
  }

  for (const a of data.alarms) {
    lines.push(
      ["Acik Alarm", SEVERITY_LABEL_TR[a.severity] ?? a.severity, a.message, "", "", "", fmtDateTime(a.created_at)].map(csvEscape).join(",")
    );
  }

  for (const v of data.variance) {
    lines.push(
      [
        "Yakit Sapma/Stok Mutabakati",
        FUEL_LABEL_TR[v.fuelType] ?? v.fuelType,
        `Olcum: ${v.readingCount}, Toplam sapma: ${v.totalVarianceLiters.toFixed(2)} L, Toplam akis: ${v.totalThroughputLiters.toFixed(2)} L, Net: %${v.netVariancePct.toFixed(2)}`,
        "",
        fmtDate(v.lastMeasuredAt),
        "",
        "",
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  return "﻿" + lines.join("\n");
}

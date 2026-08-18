import { db } from "../db/index.js";
import type { StationRow, TransactionRow } from "../db/types.js";
import { sendEmail, sendSms } from "./notificationService.js";
import { TransactionError, getTransactionForKiosk } from "./transactionService.js";

const FUEL_LABEL: Record<string, string> = { benzin: "Benzin", motorin: "Motorin", lpg: "LPG" };

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(value);
}

function buildReceiptText(t: TransactionRow, station: StationRow): string {
  return [
    `${station.name}`,
    station.address,
    "",
    `Islem No: #${t.id}`,
    `Tarih: ${t.completed_at ? new Date(t.completed_at).toLocaleString("tr-TR") : "-"}`,
    `Plaka: ${t.plate}`,
    `Yakit: ${FUEL_LABEL[t.fuel_type] ?? t.fuel_type}`,
    `Miktar: ${t.dispensed_liters.toFixed(2)} L`,
    `Litre Fiyati: ${formatCurrency(t.price_per_liter)}`,
    `Toplam Tutar: ${formatCurrency(t.total_amount)}`,
    "",
    "Bu bir sanal odeme makbuzudur.",
  ].join("\n");
}

function buildReceiptHtml(t: TransactionRow, station: StationRow): string {
  const rows: Array<[string, string]> = [
    ["Islem No", `#${t.id}`],
    ["Tarih", t.completed_at ? new Date(t.completed_at).toLocaleString("tr-TR") : "-"],
    ["Plaka", t.plate],
    ["Yakit", FUEL_LABEL[t.fuel_type] ?? t.fuel_type],
    ["Miktar", `${t.dispensed_liters.toFixed(2)} L`],
    ["Litre Fiyati", formatCurrency(t.price_per_liter)],
    ["Toplam Tutar", formatCurrency(t.total_amount)],
  ];
  return `
    <div style="font-family: sans-serif; max-width: 420px; margin: 0 auto;">
      <h2 style="margin-bottom:0">${station.name}</h2>
      <p style="color:#666; margin-top:4px">${station.address}</p>
      <table style="width:100%; border-collapse: collapse; margin-top: 1rem;">
        ${rows
          .map(
            ([label, value]) =>
              `<tr><td style="padding:6px 0; color:#666;">${label}</td><td style="padding:6px 0; text-align:right; font-weight:600;">${value}</td></tr>`
          )
          .join("")}
      </table>
      <p style="color:#999; font-size:0.85rem; margin-top:1.5rem;">Bu bir sanal odeme makbuzudur.</p>
    </div>
  `;
}

export interface ReceiptResult {
  email?: { sent: boolean; reason?: string };
  sms?: { sent: boolean; reason?: string };
}

export async function sendReceipt(
  transactionId: number,
  accessToken: string,
  target: { email?: string; phone?: string }
): Promise<ReceiptResult> {
  const t = getTransactionForKiosk(transactionId, accessToken);
  if (t.status !== "completed") {
    throw new TransactionError("Makbuz yalnizca tamamlanmis islemler icin gonderilebilir.", 409);
  }
  if (!target.email && !target.phone) {
    throw new TransactionError("E-posta veya telefon numarasindan en az biri girilmelidir.", 400);
  }

  const station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(t.station_id)!;
  const result: ReceiptResult = {};

  if (target.email) {
    result.email = await sendEmail(
      target.email,
      `Yakit Makbuzu - Islem #${t.id}`,
      buildReceiptText(t, station),
      buildReceiptHtml(t, station)
    );
  }
  if (target.phone) {
    const smsText = `${station.name} - Islem #${t.id}: ${t.dispensed_liters.toFixed(2)}L ${FUEL_LABEL[t.fuel_type] ?? t.fuel_type}, ${formatCurrency(t.total_amount)}. Tesekkurler.`;
    result.sms = await sendSms(target.phone, smsText);
  }

  db.prepare("UPDATE transactions SET receipt_email = ?, receipt_phone = ?, receipt_sent_at = ? WHERE id = ?").run(
    target.email ?? null,
    target.phone ?? null,
    new Date().toISOString(),
    t.id
  );

  return result;
}


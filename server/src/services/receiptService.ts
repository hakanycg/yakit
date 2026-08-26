import { db } from "../db/index.js";
import type { StationRow, TransactionRow } from "../db/types.js";
import { sendEmail, sendSms } from "./notificationService.js";
import { TransactionError, getTransactionForKiosk } from "./transactionService.js";
import { buildReceiptPdf } from "./receiptPdfService.js";
import { logger } from "../utils/logger.js";

const FUEL_LABEL: Record<string, string> = { benzin: "Benzin", motorin: "Motorin", lpg: "LPG" };

/**
 * "Bu bir sanal odeme makbuzudur." yaziyordu - simule odeme kaldirildiktan sonra
 * her odeme gercek (iyzico ya da filo hesabi). Musteriye "sanal" diyen bir makbuz
 * gondermek hem yanlis hem de bir uyusmazlikta aleyhte delil olurdu.
 */
const RECEIPT_FOOTER = "Bu belge bilgi amacli bir odeme makbuzudur; mali belge yerine gecmez.";

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  iyzico: "Kredi/Banka Karti",
  fleet: "Filo Hesabi",
  virtual_card: "Sanal Kart (eski kayit)",
};

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(value);
}

/**
 * Makbuz satirlari - metin ve HTML surumu ayni kaynaktan uretilir ki ikisi
 * birbirinden ayrisamasin.
 *
 * Tutar kurgusu onemli: "Ara Toplam" yakit degeri (total_amount), "Odenen" ise
 * musteriden GERCEKTEN tahsil edilen nettir (chargeAmount = total - indirim).
 * Makbuz daha once yalnizca total_amount yaziyordu: indirim kodu ya da puan
 * kullanan bir musteri, odediginden FAZLA bir tutar yazan bir makbuz aliyordu.
 * Indirim yoksa ara toplam satiri hic gosterilmez - tek kalem bir makbuzda iki
 * kez ayni rakami yazmak kafa karistirir.
 */
export function buildReceiptRows(t: TransactionRow): Array<[string, string]> {
  const charged = Math.max(0, Math.round((t.total_amount - t.discount_amount) * 100) / 100);
  const rows: Array<[string, string]> = [
    ["Islem No", `#${t.id}`],
    ["Tarih", t.completed_at ? new Date(t.completed_at).toLocaleString("tr-TR") : "-"],
    ["Plaka", t.plate],
    ["Yakit", FUEL_LABEL[t.fuel_type] ?? t.fuel_type],
    ["Miktar", `${t.dispensed_liters.toFixed(2)} L`],
    ["Litre Fiyati", formatCurrency(t.price_per_liter)],
  ];
  if (t.discount_amount > 0) {
    rows.push(["Ara Toplam", formatCurrency(t.total_amount)]);
    rows.push(["Indirim / Puan", `-${formatCurrency(t.discount_amount)}`]);
  }
  rows.push(["Odenen Tutar", formatCurrency(charged)]);
  rows.push(["Odeme Yontemi", PAYMENT_METHOD_LABEL[t.payment_method] ?? t.payment_method]);
  return rows;
}

export function buildReceiptText(t: TransactionRow, station: StationRow): string {
  return [
    `${station.name}`,
    station.address,
    ...(station.contact_phone ? [`Tel: ${station.contact_phone}`] : []),
    "",
    ...buildReceiptRows(t).map(([label, value]) => `${label}: ${value}`),
    "",
    RECEIPT_FOOTER,
  ].join("\n");
}

function buildReceiptHtml(t: TransactionRow, station: StationRow): string {
  const rows = buildReceiptRows(t);
  return `
    <div style="font-family: sans-serif; max-width: 420px; margin: 0 auto;">
      <h2 style="margin-bottom:0">${station.name}</h2>
      <p style="color:#666; margin-top:4px">${station.address}${station.contact_phone ? ` &middot; ${station.contact_phone}` : ""}</p>
      <table style="width:100%; border-collapse: collapse; margin-top: 1rem;">
        ${rows
          .map(
            ([label, value]) =>
              `<tr><td style="padding:6px 0; color:#666;">${label}</td><td style="padding:6px 0; text-align:right; font-weight:600;">${value}</td></tr>`
          )
          .join("")}
      </table>
      <p style="color:#999; font-size:0.85rem; margin-top:1.5rem;">${RECEIPT_FOOTER}</p>
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
    let attachments: { filename: string; content: Buffer; contentType?: string }[] | undefined;
    try {
      const pdf = await buildReceiptPdf(t, station);
      attachments = [{ filename: `makbuz-${t.id}.pdf`, content: pdf, contentType: "application/pdf" }];
    } catch (err) {
      // PDF olusturulamasa da e-postanin (HTML/metin govdesiyle) gitmesini engellemiyoruz.
      logger.error({ err, transactionId: t.id }, "Makbuz PDF'i olusturulamadi, e-posta ek olmadan gonderiliyor.");
    }
    result.email = await sendEmail(
      target.email,
      `Yakit Makbuzu - Islem #${t.id}`,
      buildReceiptText(t, station),
      buildReceiptHtml(t, station),
      attachments
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


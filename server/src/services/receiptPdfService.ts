import PDFDocument from "pdfkit";
import type { StationRow, TransactionRow } from "../db/types.js";
import { chargeAmount } from "./transactionService.js";

const FUEL_LABEL: Record<string, string> = { benzin: "Benzin", motorin: "Motorin", lpg: "LPG" };

/** pdfkit'in varsayilan yerlesik fontu (Helvetica/WinAnsi) Turk Lirasi sembolunu (₺, U+20BA) icermiyor
 * ve bosluk/kutu karakteri olarak basiyordu - bu yuzden burada Intl currency formatlayici yerine
 * duz "TL" son eki kullaniliyor (diger yerlerdeki formatCurrency'den kasitli olarak farkli). */
function formatCurrency(value: number): string {
  return `${new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} TL`;
}

/** Musteriye e-posta ekinde gonderilecek basit A5 boyutunda makbuz PDF'i uretir. Harici sablon/HTML-to-PDF motoru gerektirmez. */
export function buildReceiptPdf(t: TransactionRow, station: StationRow): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A5", margin: 40 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(16).text(station.name, { align: "left" });
    doc.fontSize(10).fillColor("#555").text(station.address);
    doc.moveDown(1);

    doc.strokeColor("#ccc").moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
    doc.moveDown(1);

    const charge = chargeAmount(t);
    const rows: Array<[string, string]> = [
      ["Islem No", `#${t.id}`],
      ["Tarih", t.completed_at ? new Date(t.completed_at).toLocaleString("tr-TR") : "-"],
      ["Plaka", t.plate],
      ["Yakit", FUEL_LABEL[t.fuel_type] ?? t.fuel_type],
      ["Miktar", `${t.dispensed_liters.toFixed(2)} L`],
      ["Litre Fiyati", formatCurrency(t.price_per_liter)],
      ["Yakit Degeri", formatCurrency(t.total_amount)],
    ];
    if (t.discount_amount > 0) rows.push(["Indirim", `-${formatCurrency(t.discount_amount)}`]);
    rows.push(["Odenen Tutar", formatCurrency(charge)]);

    doc.fontSize(11).fillColor("#000");
    for (const [label, value] of rows) {
      const y = doc.y;
      doc.fillColor("#555").text(label, doc.page.margins.left, y, { continued: false });
      doc.fillColor("#000").text(value, doc.page.margins.left, y, { align: "right", width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
      doc.moveDown(0.5);
    }

    doc.moveDown(1.5);
    doc.fontSize(9).fillColor("#999").text("Bu bir sanal odeme makbuzudur.", { align: "center" });

    doc.end();
  });
}

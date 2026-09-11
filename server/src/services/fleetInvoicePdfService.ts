import PDFDocument from "pdfkit";
import type { FleetAccountRow, FleetInvoiceRow, StationRow } from "../db/types.js";
import type { FleetInvoiceLine } from "./fleetInvoiceService.js";

const FUEL_LABEL: Record<string, string> = { benzin: "Benzin", motorin: "Motorin", lpg: "LPG" };

/** pdfkit'in varsayilan fontu ₺ (U+20BA) basamiyor - bkz. receiptPdfService.ts'teki ayni notu. */
function formatCurrency(value: number): string {
  return `${new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} TL`;
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("tr-TR") : "-";
}

/** Sabit genislikte sutunlar icin hucreyi kirpar/doldurur - pdfkit'in tablo destegi yok (bkz. complianceReportService.ts). */
function pad(s: string, width: number): string {
  const truncated = s.length > width ? s.slice(0, width - 1) + "…" : s;
  return truncated.padEnd(width);
}

/**
 * Filo donem (icmal) faturasinin indirilebilir PDF gorunumu.
 *
 * Bu, GIB'e gonderilen RESMI e-Fatura belgesinin YERINE GECMEZ - o saglayici (Uyumsoft)
 * tarafinda UBL-TR formatinda tutulur ve musterinin kendi GIB e-Fatura posta kutusuna
 * zaten duser (bkz. fleetInvoiceService.sendToProvider). Bu PDF yalnizca musterinin
 * portalda "faturami gormek/indirmek" istedigi an icin, ayni verinin (satirlar, toplamlar)
 * okunabilir bir dokumu - receiptPdfService.buildReceiptPdf ile ayni amac, farkli belge.
 */
export function buildFleetInvoicePdf(invoice: FleetInvoiceRow, account: FleetAccountRow, station: StationRow): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).fillColor("#000").text("Filo Dönem Faturası");
    doc.fontSize(10).fillColor("#555");
    doc.text(station.name);
    doc.text(station.address);
    doc.moveDown(1);

    doc.fontSize(11).fillColor("#000");
    const headRows: Array<[string, string]> = [
      ["Fatura No", invoice.provider_invoice_id ?? `#${invoice.id}`],
      ["Dönem", `${fmtDate(invoice.period_start)} - ${fmtDate(invoice.period_end)}`],
      ["Kesim Tarihi", fmtDate(invoice.created_at)],
      ["Vade", fmtDate(invoice.due_date)],
      ["Müşteri", account.company_name],
    ];
    if (account.vkn) headRows.push(["VKN", account.vkn]);
    for (const [label, value] of headRows) {
      const y = doc.y;
      doc.fillColor("#555").text(label, doc.page.margins.left, y);
      doc.fillColor("#000").text(value, doc.page.margins.left, y, {
        align: "right",
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      });
      doc.moveDown(0.4);
    }

    doc.moveDown(1);
    doc.strokeColor("#ccc").moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
    doc.moveDown(0.8);

    function tableRow(cells: string[], widths: number[], bold = false) {
      doc.font(bold ? "Courier-Bold" : "Courier").fontSize(9).fillColor("#000");
      doc.text(cells.map((c, i) => pad(c, widths[i]!)).join(" "));
    }

    const lines = JSON.parse(invoice.lines_json) as FleetInvoiceLine[];
    const widths = [14, 14, 12, 16, 14, 14];
    tableRow(["Plaka", "Yakıt", "Litre", "KDV Hariç", "KDV", "Tutar"], widths, true);
    for (const l of lines) {
      tableRow(
        [
          l.plate,
          FUEL_LABEL[l.fuelType] ?? l.fuelType,
          l.liters.toFixed(2),
          formatCurrency(l.taxExclusiveAmount),
          formatCurrency(l.taxAmount),
          formatCurrency(l.amount),
        ],
        widths
      );
    }

    doc.moveDown(1);
    doc.font("Helvetica").fontSize(11).fillColor("#000");
    const totalRows: Array<[string, string]> = [
      ["Toplam Litre", `${invoice.total_liters.toFixed(2)} L`],
      ["KDV Hariç Toplam", formatCurrency(invoice.tax_exclusive_amount)],
      ["KDV Toplam", formatCurrency(invoice.tax_amount)],
      ["Genel Toplam", formatCurrency(invoice.payable_amount)],
    ];
    for (const [label, value] of totalRows) {
      const y = doc.y;
      const bold = label === "Genel Toplam";
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fillColor("#555").text(label, doc.page.margins.left, y);
      doc.fillColor("#000").text(value, doc.page.margins.left, y, {
        align: "right",
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      });
      doc.moveDown(0.4);
    }

    doc.moveDown(1.5);
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#999")
      .text(
        "Bu belge bilgi amaçlıdır. Resmi e-Fatura belgeniz GİB e-Fatura posta kutunuza ayrıca ulaşmıştır.",
        { align: "center" }
      );

    doc.end();
  });
}

import type { TransactionRow } from "../db/types.js";
import { logger } from "../utils/logger.js";
import { recordAudit } from "./auditService.js";
import { createInvoice } from "./invoiceService.js";
import { getInvoiceForTransaction, recordInvoiceFailure, recordInvoiceSuccess } from "./invoiceRecordService.js";
import { isInvoiceReady } from "./invoiceSettingsService.js";

/**
 * Satis biter bitmez e-Arsiv faturayi KENDILIGINDEN keser.
 *
 * Daha once fatura yalnizca panelde "E-Fatura Olustur" dugmesine basildiginda
 * kesiliyordu. Personelsiz bir istasyonda o dugmeye basacak kimse yok: fatura,
 * birinin gun icinde islem listesini acip tek tek tiklamasina kaliyordu - yani
 * pratikte hic kesilmiyordu. Fatura kesmek yasal bir yukumluluk, bir panel
 * eylemi degil.
 *
 * Dugme kaldirilmadi ama artik ROLU DEGISTI: otomatik kesim saglayici hatasi
 * nedeniyle basarisiz olursa (baglanti yok, VKN reddedildi...) kayit "failed"
 * olarak durur ve dugme o kaydin YENIDEN DENEME yolu olur.
 *
 * Hicbir kosulda hata firlatmaz: fatura saglayicisinin erisilemez olmasi, biten
 * bir satisin akisini bozmamali - musteri yakitini almis, pompa serbest kalmis
 * olmali.
 */
export function issueInvoiceAutomatically(t: TransactionRow): void {
  if (t.status !== "completed") return;
  // Hicbir sey tahsil edilmemisse (ör. 0 litre ile kapanan islem) kesilecek fatura yok.
  if (Math.max(0, t.total_amount - t.discount_amount) <= 0) return;
  // Entegrasyon kurulmamis istasyonlarda sessizce gecilir - burasi bir hata degil,
  // "bu istasyon henuz e-belge kullanmiyor" durumudur.
  if (!isInvoiceReady(t.station_id).ready) return;
  // Ayni islem icin daha once (elle ya da otomatik) basarili fatura kesildiyse tekrar kesilmez.
  if (getInvoiceForTransaction(t.id)?.status === "sent") return;

  void createInvoice(t)
    .then((result) => {
      recordInvoiceSuccess(t.station_id, t.id, result.providerInvoiceId, null);
      recordAudit({
        user: null,
        actorType: "system",
        actorLabel: "otomatik faturalama",
        action: "invoice_created",
        entityType: "transaction",
        entityId: String(t.id),
        details: { providerInvoiceId: result.providerInvoiceId, automatic: true },
        stationId: t.station_id,
      });
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Fatura olusturulamadi.";
      recordInvoiceFailure(t.station_id, t.id, message, null);
      recordAudit({
        user: null,
        actorType: "system",
        actorLabel: "otomatik faturalama",
        action: "invoice_failed",
        entityType: "transaction",
        entityId: String(t.id),
        details: { error: message, automatic: true },
        stationId: t.station_id,
      });
      logger.error({ err, transactionId: t.id }, "Otomatik e-fatura kesilemedi - panelden yeniden denenebilir.");
    });
}

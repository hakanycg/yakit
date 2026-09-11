import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { FUEL_LABEL, formatCurrency, formatDateTime, formatLiters } from "../shared/format";
import { kioskApi } from "../kiosk/kioskApi";
import { ApiError } from "../shared/api";
import type { Transaction } from "../shared/types";

/**
 * Musterinin kiosk'taki fisi tarayamadan/kaybetmeden sonra QR koduyla acabildigi
 * GIRISSIZ dijital makbuz sayfasi (bkz. kiosk/steps/ReceiptStep.tsx'teki QR kod).
 *
 * Ayri bir sunucu ucu GEREKMEDI: erisim, islemin olusumunda uretilen ve zaten
 * GET /api/kiosk/transactions/:id icin kullanilan `kiosk_access_token` ile
 * korunuyor (bkz. routes/kiosk.ts requireAccessToken) - bu token suresiz gecerli
 * ve sadece bu tek islemi acar, o yuzden QR'a gomulmesi yeni bir yetki genislemesi
 * degil, mevcut yetkinin baska bir tasima bicimidir.
 *
 * Personel oturumu/AppLayout kullanilmaz (bkz. FleetPortal.tsx'teki ayni gerekce).
 */
export default function DigitalReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!id || !token) {
      setLoadError("Geçersiz makbuz linki.");
      return;
    }
    kioskApi
      .getTransaction(Number(id), token)
      .then((res) => setTransaction(res.transaction))
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Makbuz yüklenemedi."));
  }, [id, token]);

  return (
    <div className="login-shell">
      <div className="login-card" style={{ maxWidth: 420 }}>
        <h2 style={{ textAlign: "center" }}>Dijital Makbuz</h2>
        {loadError && <p className="error-text">{loadError}</p>}
        {!loadError && !transaction && <p className="hint-text">Yükleniyor...</p>}
        {transaction && (
          <div style={{ textAlign: "left" }}>
            <div className="toolbar"><span>Plaka</span><div className="spacer" /><strong dir="ltr">{transaction.plate}</strong></div>
            <div className="toolbar"><span>Yakıt</span><div className="spacer" /><strong>{FUEL_LABEL[transaction.fuelType] ?? transaction.fuelType}</strong></div>
            <div className="toolbar"><span>Miktar</span><div className="spacer" /><strong>{formatLiters(transaction.dispensedLiters)}</strong></div>
            <div className="toolbar"><span>Birim Fiyat</span><div className="spacer" /><strong>{formatCurrency(transaction.pricePerLiter)}</strong></div>
            {transaction.discountAmount > 0 ? (
              <>
                <div className="toolbar"><span>Yakıt Bedeli</span><div className="spacer" /><strong>{formatCurrency(transaction.totalAmount)}</strong></div>
                <div className="toolbar"><span>İndirim</span><div className="spacer" /><strong>-{formatCurrency(transaction.discountAmount)}</strong></div>
                <div className="toolbar"><span>Tahsil Edilen</span><div className="spacer" /><strong style={{ fontSize: "1.2rem" }}>{formatCurrency(transaction.chargeAmount)}</strong></div>
              </>
            ) : (
              <div className="toolbar"><span>Toplam Tutar</span><div className="spacer" /><strong style={{ fontSize: "1.2rem" }}>{formatCurrency(transaction.totalAmount)}</strong></div>
            )}
            {transaction.loyaltyPointsEarned > 0 && (
              <div className="toolbar"><span>Kazanılan Puan</span><div className="spacer" /><strong>{transaction.loyaltyPointsEarned}</strong></div>
            )}
            <div className="toolbar"><span>İşlem No</span><div className="spacer" /><strong>#{transaction.id}</strong></div>
            <div className="toolbar"><span>Tarih</span><div className="spacer" /><strong>{formatDateTime(transaction.completedAt)}</strong></div>
            {transaction.cancelledReason && <p className="hint-text" style={{ marginTop: "0.75rem" }}>{transaction.cancelledReason}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";

interface TrackingInfo {
  orderId: number;
  stationName: string;
  fuelType: string;
  orderedLiters: number;
  status: string;
}

const FUEL_LABEL: Record<string, string> = { benzin: "Benzin", motorin: "Motorin", lpg: "LPG" };

/**
 * Tanker canli konum takibi - soforun kendi telefonundan, SMS ile gelen linkle
 * acilan GIRISSIZ sayfa (bkz. server/src/routes/tankerTracking.ts).
 *
 * Personel oturumu/AppLayout kullanilmaz (bkz. FleetPortal.tsx'teki ayni gerekce).
 * Soforun ekraninda harita YOK - burasi bilerek yalnizca izin+durum gosterir;
 * canli harita istasyon tarafinda (FuelStock.tsx'teki TankerLocationDialog).
 */
export default function TankerTrackingPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [info, setInfo] = useState<TrackingInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [lastSentAt, setLastSentAt] = useState<Date | null>(null);
  const watchIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!orderId || !token) {
      setLoadError("Geçersiz takip linki.");
      return;
    }
    fetch(`/api/tanker-tracking/${orderId}?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Takip linki geçersiz veya süresi dolmuş.");
        setInfo(data.tracking);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Bağlantı hatası."));
  }, [orderId, token]);

  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    };
  }, []);

  function startSharing() {
    if (!navigator.geolocation) {
      setShareError("Bu cihaz/tarayıcı konum paylaşımını desteklemiyor.");
      return;
    }
    setShareError(null);
    setSharing(true);
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        fetch(`/api/tanker-tracking/${orderId}/location`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, lat: pos.coords.latitude, lng: pos.coords.longitude }),
        })
          .then((res) => {
            if (res.ok) setLastSentAt(new Date());
          })
          .catch(() => {
            /* Bir sonraki konum guncellemesinde tekrar denenir - tek bir agi
               kesintisi paylasimi tamamen durdurmamali. */
          });
      },
      (err) => setShareError(err.message || "Konum alınamadı. Konum izni verildiğinden emin olun."),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 }
    );
  }

  function stopSharing() {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setSharing(false);
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "1.5rem", background: "#f4f4f5" }}>
      <div className="card" style={{ width: "min(420px, 100%)", textAlign: "center" }}>
        <h2 style={{ marginTop: 0 }}>Tanker Konum Paylaşımı</h2>

        {loadError && <p className="error-text">{loadError}</p>}

        {!loadError && !info && <p className="hint-text">Yükleniyor...</p>}

        {info && (
          <>
            <p>
              <strong>{info.stationName}</strong> istasyonuna{" "}
              <strong>
                {FUEL_LABEL[info.fuelType] ?? info.fuelType} {info.orderedLiters.toFixed(0)} L
              </strong>{" "}
              teslimatı için konumunuzu paylaşabilirsiniz.
            </p>

            {!sharing ? (
              <button className="primary" style={{ width: "100%", padding: "0.9rem", fontSize: "1.05rem" }} onClick={startSharing}>
                Konum Paylaşımını Başlat
              </button>
            ) : (
              <>
                <p style={{ color: "#1a7f37", fontWeight: 600 }}>✓ Konumunuz paylaşılıyor</p>
                {lastSentAt && <p className="hint-text">Son gönderim: {lastSentAt.toLocaleTimeString("tr-TR")}</p>}
                <button style={{ width: "100%", padding: "0.75rem" }} onClick={stopSharing}>
                  Paylaşımı Durdur
                </button>
              </>
            )}

            {shareError && <p className="error-text">{shareError}</p>}

            <p className="hint-text" style={{ marginTop: "1.5rem" }}>
              Bu sayfa yalnızca konumunuzu istasyon personeline iletir; başka hiçbir bilgi paylaşılmaz. Teslimat
              tamamlanınca sekmeyi kapatabilirsiniz.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

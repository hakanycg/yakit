import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { kioskApi, type StationResponse } from "./kioskApi";
import { useTopicSubscription } from "../shared/useWebSocket";
import type { FuelType, Pump, Transaction } from "../shared/types";
import PlateStep from "./steps/PlateStep";
import PumpStep from "./steps/PumpStep";
import FuelStep from "./steps/FuelStep";
import AmountStep, { type AmountSelection } from "./steps/AmountStep";
import PaymentStep from "./steps/PaymentStep";
import DispenseStep from "./steps/DispenseStep";
import ReceiptStep from "./steps/ReceiptStep";
import { ApiError } from "../shared/api";
import { clearPendingKioskTransaction, readPendingKioskTransaction } from "./resumeStorage";

type Step = "plate" | "pump" | "fuel" | "amount" | "creating" | "payment" | "iyzico-wait" | "dispense" | "receipt";

const STEP_ORDER: Step[] = ["plate", "pump", "fuel", "amount", "payment", "dispense", "receipt"];

function computeTargetLiters(t: Transaction): number {
  if (t.amountMode === "liters") return t.requestedLiters ?? 0;
  if (t.amountMode === "amount") return (t.requestedAmount ?? 0) / t.pricePerLiter;
  return 55;
}

export default function KioskFlow() {
  const { slug } = useParams<{ slug: string }>();
  const [station, setStation] = useState<StationResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("plate");
  const [plate, setPlate] = useState("");
  const [plateSource, setPlateSource] = useState<"manual" | "lpr">("manual");
  const [pump, setPump] = useState<Pump | null>(null);
  const [fuelType, setFuelType] = useState<FuelType | null>(null);
  const [amountSelection, setAmountSelection] = useState<AmountSelection | null>(null);
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetLiters, setTargetLiters] = useState(0);

  const loadStation = useCallback(() => {
    if (!slug) return;
    kioskApi
      .getStation(slug)
      .then((res) => {
        setStation(res);
        setLoadError(null);
      })
      .catch((err) => {
        setLoadError(err instanceof ApiError ? err.message : "Istasyon yuklenemedi.");
      });
  }, [slug]);

  useEffect(loadStation, [loadStation]);
  useTopicSubscription(station ? `pumps:${station.station.id}` : null, (payload) => {
    setStation((prev) => (prev ? { ...prev, pumps: payload as Pump[] } : prev));
  });

  // iyzico odemesi tamamlandiginda musteri, sunucunun sonucu dogruladigi callback
  // uzerinden tam sayfa yonlendirmeyle bu adrese (?tx=...) geri doner; SPA state'i bu
  // yonlendirmede kaybolduğu icin islem kimligi/erisim tokeni yerelden geri yuklenir.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const txParam = params.get("tx");
    if (!txParam) return;
    const id = Number(txParam);

    window.history.replaceState(null, "", window.location.pathname);

    const pending = readPendingKioskTransaction(id);
    clearPendingKioskTransaction();
    if (!pending) return;

    kioskApi
      .getTransaction(id, pending.accessToken)
      .then((res) => {
        const t = res.transaction;
        setTransaction(t);
        setAccessToken(pending.accessToken);
        if (t.status === "completed" || t.status === "cancelled" || t.status === "failed") {
          setStep("receipt");
        } else if (t.status === "authorized" || t.status === "dispensing") {
          setTargetLiters(computeTargetLiters(t));
          setStep("dispense");
        } else {
          // Odeme sonucu henuz sunucuya ulasmamis olabilir; WS baglantisi kurulunca
          // asagidaki abonelik geldigi anda durumu yakalayip yonlendirecektir.
          setStep("iyzico-wait");
        }
      })
      .catch(() => {
        setError("Odeme sonrasi islem bilgisi alinamadi. Lutfen yeni bir islem baslatin.");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useTopicSubscription(transaction ? `transaction:${transaction.id}` : null, (payload) => {
    const t = payload as Transaction;
    setTransaction(t);
    if (t.status === "completed" || t.status === "cancelled" || t.status === "failed") {
      setStep("receipt");
    } else if (t.status === "authorized" || t.status === "dispensing") {
      setTargetLiters((prev) => (prev > 0 ? prev : computeTargetLiters(t)));
      setStep((prev) => (prev === "payment" || prev === "iyzico-wait" ? "dispense" : prev));
    }
  }, accessToken ?? undefined);

  function reset() {
    setStep("plate");
    setPlate("");
    setPump(null);
    setFuelType(null);
    setAmountSelection(null);
    setTransaction(null);
    setAccessToken(null);
    setError(null);
    loadStation();
  }

  async function handleAmount(selection: AmountSelection) {
    if (!pump || !fuelType || !station) return;
    setAmountSelection(selection);
    setError(null);
    setStep("creating");

    const price = station.fuelPrices.find((f) => f.fuelType === fuelType)!;
    const liters = selection.mode === "liters" ? selection.liters : selection.mode === "amount" ? selection.amount / price.pricePerLiter : 55;
    setTargetLiters(liters);

    try {
      const res = await kioskApi.createTransaction({
        pumpId: pump.id,
        plate,
        plateSource,
        fuelType,
        amountMode: selection.mode,
        requestedAmount: selection.mode === "amount" ? selection.amount : undefined,
        requestedLiters: selection.mode === "liters" ? selection.liters : undefined,
      });
      setTransaction(res.transaction);
      setAccessToken(res.accessToken);
      setStep("payment");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Islem olusturulamadi.");
      setStep("amount");
    }
  }

  if (loadError) {
    return (
      <div className="kiosk-shell">
        <div className="kiosk-card">
          <h2>Istasyon Bulunamadi</h2>
          <p className="error-text">{loadError}</p>
          <p className="hint-text">Bu kiosk terminalinin adresi hatali olabilir. Lutfen istasyon yoneticinizle iletisime gecin.</p>
        </div>
      </div>
    );
  }

  if (!station) {
    return (
      <div className="kiosk-shell">
        <div className="kiosk-card">Yukleniyor...</div>
      </div>
    );
  }

  const stepIndex = STEP_ORDER.indexOf(step === "creating" ? "amount" : step === "iyzico-wait" ? "payment" : step);

  return (
    <div className="kiosk-shell">
      <div className="kiosk-card">
        <div className="kiosk-steps">
          {STEP_ORDER.map((s, i) => (
            <div key={s} className={`step ${i <= stepIndex ? "done" : ""}`} />
          ))}
        </div>

        {error && step !== "amount" && <p className="error-text">{error}</p>}

        {step === "plate" && (
          <PlateStep
            onNext={(p, source) => {
              setPlate(p);
              setPlateSource(source);
              setStep("pump");
            }}
          />
        )}

        {step === "pump" && (
          <PumpStep pumps={station.pumps} onNext={(p) => { setPump(p); setStep("fuel"); }} onBack={() => setStep("plate")} />
        )}

        {step === "fuel" && pump && (
          <FuelStep pump={pump} fuelPrices={station.fuelPrices} onNext={(f) => { setFuelType(f); setStep("amount"); }} onBack={() => setStep("pump")} />
        )}

        {step === "amount" && fuelType && (
          <AmountStep
            price={station.fuelPrices.find((f) => f.fuelType === fuelType)!}
            onNext={handleAmount}
            onBack={() => setStep("fuel")}
          />
        )}

        {step === "creating" && <p className="hint-text">Pompa rezerve ediliyor ve odeme ekranina yonlendiriliyorsunuz...</p>}

        {step === "payment" && transaction && accessToken && (
          <PaymentStep
            transaction={transaction}
            accessToken={accessToken}
            iyzicoEnabled={station.iyzicoEnabled}
            onPaid={(t) => { setTransaction(t); setStep("dispense"); }}
            onCancel={reset}
          />
        )}

        {step === "iyzico-wait" && transaction && (
          <div>
            <h2>Odeme Sonucu Bekleniyor</h2>
            <p className="hint-text">iyzico odeme sonucunuz dogrulaniyor, lutfen bekleyin...</p>
          </div>
        )}

        {step === "dispense" && transaction && <DispenseStep transaction={transaction} targetLiters={targetLiters} />}

        {step === "receipt" && transaction && (
          <ReceiptStep transaction={transaction} accessToken={accessToken} onRestart={reset} />
        )}
      </div>
    </div>
  );
}

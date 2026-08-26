import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { kioskApi, type StationResponse } from "./kioskApi";
import { useTopicSubscription } from "../shared/useWebSocket";
import type { FuelTank, FuelType, Pump, Transaction } from "../shared/types";
import WelcomeStep from "./steps/WelcomeStep";
import PlateStep from "./steps/PlateStep";
import PumpStep from "./steps/PumpStep";
import FuelStep from "./steps/FuelStep";
import AmountStep, { type AmountSelection } from "./steps/AmountStep";
import PaymentStep from "./steps/PaymentStep";
import DispenseStep from "./steps/DispenseStep";
import ReceiptStep from "./steps/ReceiptStep";
import { ApiError } from "../shared/api";
import { clearPendingKioskTransaction, readPendingKioskTransaction } from "./resumeStorage";
import { KioskLangProvider, LanguageSwitcher, RTL_LANGS, useKioskLang } from "./i18n";
import PrivacyNoticeLink from "./PrivacyNotice";
import HelpRequestLink from "./HelpRequest";
import PriceHistoryLink from "./PriceHistory";
import VoiceGuidanceToggle from "./VoiceGuidanceToggle";
import { playClickSound, speak } from "./voiceGuidance";
import { useIdleReset } from "./useIdleReset";
import { useConnectivity } from "./useConnectivity";
import { useDayNightMode } from "./useDayNightMode";
import { consumeKioskDeviceTokenFromUrl } from "./kioskDeviceToken";

type Step = "welcome" | "plate" | "pump" | "fuel" | "amount" | "creating" | "payment" | "iyzico-wait" | "dispense" | "receipt";

const STEP_ORDER: Step[] = ["plate", "pump", "fuel", "amount", "payment", "dispense", "receipt"];

function computeTargetLiters(t: Transaction): number {
  if (t.amountMode === "liters") return t.requestedLiters ?? 0;
  if (t.amountMode === "amount") return (t.requestedAmount ?? 0) / t.pricePerLiter;
  return 55;
}

export default function KioskFlow() {
  return (
    <KioskLangProvider>
      <KioskFlowInner />
    </KioskLangProvider>
  );
}

function KioskFlowInner() {
  const { t, lang, locale } = useKioskLang();
  const dir = RTL_LANGS.includes(lang) ? "rtl" : "ltr";
  const { slug } = useParams<{ slug: string }>();
  const [station, setStation] = useState<StationResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("welcome");
  const [plate, setPlate] = useState("");
  const [plateSource, setPlateSource] = useState<"manual" | "lpr">("manual");
  const [pump, setPump] = useState<Pump | null>(null);
  const [fuelType, setFuelType] = useState<FuelType | null>(null);
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetLiters, setTargetLiters] = useState(0);
  const [estimatedPricePerLiter, setEstimatedPricePerLiter] = useState<number | null>(null);
  const online = useConnectivity();
  // Gunduz/gece gecisi sabit saatle degil istasyonun kendi konumundaki alacakaranlikla
  // olur (bkz. useDayNightMode.ts). Istasyon yuklenene kadar konum bilinmedigi icin
  // hook o ana kadar saat tabanli yedege duser.
  const dayNightMode = useDayNightMode(station?.station ?? null);

  const loadStation = useCallback(() => {
    if (!slug) return;
    // Kurulumda adrese eklenen ?device=<token> varsa saklanip URL'den temizlenir;
    // sonraki tum kiosk API cagrilari bu tokenle imzalanir.
    consumeKioskDeviceTokenFromUrl();
    kioskApi
      .getStation(slug)
      .then((res) => {
        setStation(res);
        setLoadError(null);
      })
      .catch((err) => {
        setLoadError(err instanceof ApiError ? err.message : t("error.stationLoadFailed"));
      });
  }, [slug]);

  useEffect(loadStation, [loadStation]);

  /**
   * Kiosk kalp atisi. Bu olmadan panel, gece boyu musteri gelmeyen bir istasyonun
   * saglam kiosk'unu "cevrimdisi" gosterirdi: last_seen_at yalnizca musteri
   * kullandiginda guncellenirdi. Duzenli sinyal, "kimse kullanmiyor" ile "cihaz
   * dusmus" durumlarini birbirinden ayirir.
   *
   * Hatalar sessizce yutulur: kalp atisi musteriyi ilgilendiren bir akis degil,
   * gecici bir kesinti kiosk ekraninda hata gostermemeli.
   */
  useEffect(() => {
    if (!station) return;
    const beat = () => {
      kioskApi.heartbeat().catch(() => {});
    };
    beat();
    const interval = setInterval(beat, 60_000);
    return () => clearInterval(interval);
  }, [station]);
  useTopicSubscription(station ? `pumps:${station.station.id}` : null, (payload) => {
    setStation((prev) => (prev ? { ...prev, pumps: payload as Pump[] } : prev));
  });

  // Operator stok ekledigi/dusurdugunde kiosk'taki "tukendi" durumu yenilenmeden
  // gecerliligini yitirmesin diye tank seviyelerini canli izler.
  useTopicSubscription(station ? `fuel-stock:${station.station.id}` : null, (payload) => {
    const tanks = payload as FuelTank[];
    setStation((prev) => {
      if (!prev) return prev;
      const stockByType = new Map(tanks.map((t) => [t.fuelType, t.currentLiters]));
      return {
        ...prev,
        fuelPrices: prev.fuelPrices.map((f) =>
          stockByType.has(f.fuelType) ? { ...f, inStock: (stockByType.get(f.fuelType) ?? 0) > 0 } : f
        ),
      };
    });
  });

  // Kiosk sayfasi genelde saatlerce/gunlerce hic yenilenmeden ayni sekmede acik
  // kalir; fiyat degisikligi (manuel veya zamanlanmis) ile ekranda gorunen fiyat
  // arasinda uzun bir bayatlama penceresi olusmamasi icin fiyatlar da (stok gibi)
  // canli izlenir - musteri her zaman guncel fiyati gorur.
  useTopicSubscription(station ? `fuel-prices:${station.station.id}` : null, (payload) => {
    const prices = payload as StationResponse["fuelPrices"];
    setStation((prev) => (prev ? { ...prev, fuelPrices: prices } : prev));
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
        setError(t("error.paymentInfoLoadFailed"));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyTransactionUpdate = useCallback((t: Transaction) => {
    setTransaction(t);
    if (t.status === "completed" || t.status === "cancelled" || t.status === "failed") {
      setStep("receipt");
    } else if (t.status === "authorized" || t.status === "dispensing") {
      setTargetLiters((prev) => (prev > 0 ? prev : computeTargetLiters(t)));
      setStep((prev) => (prev === "payment" || prev === "iyzico-wait" ? "dispense" : prev));
    }
  }, []);

  useTopicSubscription(
    transaction ? `transaction:${transaction.id}` : null,
    (payload) => applyTransactionUpdate(payload as Transaction),
    accessToken ?? undefined
  );

  // WebSocket, tam bu dolumun bittigi anda kisa bir baglanti kopmasina denk gelirse
  // (ör. proxy/yeniden baslatma), musteri "Dolum Yapiliyor" ekraninda sonsuza dek
  // takili kalabilir - operator uzaktan (Acil Durdur) islemi bitirmis olsa bile. Bu
  // yuzden dolum adiminda WS'e ek olarak periyodik bir REST sorgusu da yapilir; WS
  // olayi kacsa bile en gec birkac saniye icinde gercek durum yakalanir.
  useEffect(() => {
    if (step !== "dispense" || !transaction || !accessToken) return;
    const interval = setInterval(() => {
      kioskApi
        .getTransaction(transaction.id, accessToken)
        .then((res) => applyTransactionUpdate(res.transaction))
        .catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [step, transaction, accessToken, applyTransactionUpdate]);

  /**
   * Odeme adiminda takili kalan ekrani kurtarir (bkz. gorev #99).
   *
   * Musteri odeme formunu acip uzaklasirsa hicbir sey ekrani sifirlamiyordu: bosta-kalma
   * sayaci (useIdleReset) odeme adiminda bilincli olarak KAPALI, cunku iyzico formu
   * capraz-kaynakli bir cerceve icinde ve musteri kart bilgisi yazarken bizim pencerede
   * hicbir olay olusmuyor - sayac acik olsa musteriyi yazarken disari atardi. Sonuc:
   * siradaki musteri, oncekinin yarim kalmis odeme formuyla karsilasiyordu.
   *
   * Cozum bir zamanlayici DEGIL: ekran islemin gercek durumunu izler. Sunucu, odemesi
   * tamamlanmayan islemleri zaten 3 dakika sonra iptal ediyor (bkz.
   * reconcileStaleCreatedTransactions) - pompayi serbest birakarak, rezerve puani/kodu
   * iade ederek ve gec gelen odemeye karsi guvenlik agiyla. Burada ayri bir sure
   * tanimlamak, iki tarafin farkli anlara karar vermesi demek olurdu; onun yerine
   * kiosk o karari izleyip ekrani ona gore sifirliyor.
   */
  useEffect(() => {
    if ((step !== "payment" && step !== "iyzico-wait") || !transaction || !accessToken) return;
    const interval = setInterval(() => {
      kioskApi
        .getTransaction(transaction.id, accessToken)
        .then((res) => {
          const t = res.transaction;
          if (t.status === "cancelled" || t.status === "failed") {
            // Musteri odemeyi tamamlamadi ve sunucu islemi kapatti: ekrani siradaki
            // musteri icin bosalt. Makbuz ekranina dusurmek yaniltici olurdu - ortada
            // gosterilecek bir islem yok, musteri de coktan gitmis.
            reset();
            return;
          }
          applyTransactionUpdate(t);
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
    // reset bilerek bagimliliklarda degil: her render'da yeniden tanimlandigi icin
    // eklenseydi sorgu araligi saniyede bir sifirlanip hic tetiklenmeyebilirdi.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, transaction, accessToken, applyTransactionUpdate]);

  function reset() {
    // Bir sonraki musteri icin kiosk her zaman karsilama/dil secim ekranina doner - onceki
    // musterinin plakasi/bilgileri gorunmez, dil secimi de sifirdan yapilir (bkz. WelcomeStep).
    setStep("welcome");
    setPlate("");
    setPump(null);
    setFuelType(null);
    setTransaction(null);
    setAccessToken(null);
    setError(null);
    setEstimatedPricePerLiter(null);
    loadStation();
  }

  // Odeme/dolum surerken bosta-kalma sifirlamasi devre disi: fiziksel dolum veya kart
  // odemesi ekrandan bagimsiz surer, ekranin kendiliginden basa donmesi musteriyi yanlis
  // yonlendirir (ör. odeme onaylanmisken "iptal edildi" izlenimi verir).
  // "plate" adiminda henuz hicbir sey girilmemisse (bos/karsilama ekrani) korunacak bir
  // musteri verisi yoktur - bosta-kalma uyarisini burada da gostermek anlamsiz/rahatsiz
  // edicidir. Sadece musteri plaka yazmaya/LPR ile taramaya basladiktan sonra devreye girer.
  const idleEnabled =
    (step === "plate" && plate.length > 0) || step === "pump" || step === "fuel" || step === "amount" || step === "receipt";
  const idle = useIdleReset(idleEnabled, reset, 60_000, 20_000);

  // Erisilebilirlik: sesli yonlendirme acikken her adim degisiminde (ve dil degisiminde)
  // o ekranin basligi sesli olarak okunur - musteri (voiceGuidance.ts icinde no-op oldugu
  // icin) bunu hic acmadiysa performans/davranis etkilenmez.
  useEffect(() => {
    const announcement: Partial<Record<Step, string>> = {
      welcome: t("welcome.title"),
      plate: t("plate.title"),
      pump: t("pump.title"),
      fuel: t("fuelStep.title"),
      amount: t("amount.title"),
      payment: t("voice.paymentStep"),
      dispense: t("voice.dispenseStep"),
      receipt: transaction && (transaction.status === "failed" || transaction.status === "cancelled") ? t("receipt.failedTitle") : t("receipt.completedTitle"),
    };
    const text = announcement[step];
    if (text) speak(text, locale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, lang]);

  // Erisilebilirlik: her buton tiklamasinda kisa bir sesli geri bildirim (voiceGuidance.ts
  // icinde sesli yonlendirme kapaliyken zaten no-op'tur).
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if ((e.target as HTMLElement | null)?.closest("button")) playClickSound();
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  async function handleAmount(selection: AmountSelection) {
    if (!pump || !fuelType || !station) return;
    setError(null);
    setStep("creating");

    const price = station.fuelPrices.find((f) => f.fuelType === fuelType)!;
    const liters = selection.mode === "liters" ? selection.liters : selection.mode === "amount" ? selection.amount / price.pricePerLiter : 55;
    setTargetLiters(liters);
    // Musterinin tutar secimi yaparken ekranda gordugu fiyat - islem olusturulurken
    // (sunucuda) fiyat degismis olabilir; PaymentStep bu farki tespit edip musteriye
    // acikca bildirir (bkz. asagidaki "priceChangedNote").
    setEstimatedPricePerLiter(price.pricePerLiter);

    try {
      const res = await kioskApi.createTransaction({
        pumpId: pump.id,
        plate,
        plateSource,
        fuelType,
        amountMode: selection.mode,
        requestedAmount: selection.mode === "amount" ? selection.amount : undefined,
        requestedLiters: selection.mode === "liters" ? selection.liters : undefined,
        discountCode: selection.mode !== "full_tank" ? selection.discountCode : undefined,
        redeemPoints: selection.mode !== "full_tank" ? selection.redeemPoints : undefined,
      });
      setTransaction(res.transaction);
      setAccessToken(res.accessToken);
      setStep("payment");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("error.transactionCreateFailed"));
      setStep("amount");
    }
  }

  if (loadError) {
    return (
      <div className="kiosk-shell" data-kiosk-mode={dayNightMode} dir={dir}>
        <div className="kiosk-card">
          <LanguageSwitcher />
          <h2>{t("stationNotFound.title")}</h2>
          <p className="error-text">{loadError}</p>
          <p className="hint-text">{t("stationNotFound.hint")}</p>
        </div>
      </div>
    );
  }

  if (!station) {
    return (
      <div className="kiosk-shell" data-kiosk-mode={dayNightMode} dir={dir}>
        <div className="kiosk-card">
          <LanguageSwitcher />
          {t("loading")}
        </div>
      </div>
    );
  }

  /**
   * Kiosk tek bir pompanin basinda duruyorsa (yonetim panelinden o pompaya baglanmissa)
   * musteri zaten o pompanin onunde durur; ona "hangi pompadasiniz?" diye sormak hem
   * gereksiz bir adim hem de yanlis pompayi secip baska bir musterinin dolumunu
   * baslatmasina acik kapidir.
   *
   * Pompa arizali/mesgulse otomatik secim YAPILMAZ: bagli pompa kullanilamaz durumdayken
   * musteriyi sessizce o pompaya kilitlemek onu cikissiz birakirdi. O durumda secim adimi
   * eskisi gibi gosterilir ve musteri komsu pompayi secebilir.
   */
  const boundPump =
    station.pumps.find((p) => p.id === station.boundPumpId && p.status === "idle") ?? null;

  // Bagli pompada secim adimi hic gorunmedigi icin adim cubugundan da cikarilir -
  // aksi halde musteri hic gormeyecegi bir adimin isaretini bekler.
  const stepOrder = boundPump ? STEP_ORDER.filter((s) => s !== "pump") : STEP_ORDER;
  const stepIndex =
    step === "welcome" ? -1 : stepOrder.indexOf(step === "creating" ? "amount" : step === "iyzico-wait" ? "payment" : step);

  return (
    <div className="kiosk-shell" data-kiosk-mode={dayNightMode} dir={dir}>
      <div className="kiosk-card">
        {/* Karsilama ekraninin kendi buyuk dil secim karti var (bkz. WelcomeStep) - ayni
            ekranda kucuk kose anahtarini ve henuz hicbir seyin baslamadigi adim cubugunu
            tekrar gostermek gereksiz/karmasik olurdu. */}
        {step !== "welcome" && (
          <LanguageSwitcher>
            <VoiceGuidanceToggle />
          </LanguageSwitcher>
        )}
        {step !== "welcome" && (
          <div className="kiosk-steps">
            {stepOrder.map((s, i) => (
              <div key={s} className={`step ${i <= stepIndex ? "done" : ""}`} />
            ))}
          </div>
        )}

        {!online && <p className="error-text kiosk-offline-banner">{t("offline.banner")}</p>}

        {error && step !== "amount" && <p className="error-text">{error}</p>}

        {step === "welcome" && !online && <p className="hint-text">{t("offline.welcomeBlocked")}</p>}
        {step === "welcome" && (
          <WelcomeStep stationName={station.station.name} onNext={() => online && setStep("plate")} />
        )}

        {step === "plate" && (
          <PlateStep
            onNext={(p, source) => {
              setPlate(p);
              setPlateSource(source);
              if (boundPump) {
                setPump(boundPump);
                setStep("fuel");
              } else {
                setStep("pump");
              }
            }}
          />
        )}

        {step === "pump" && (
          <PumpStep pumps={station.pumps} onNext={(p) => { setPump(p); setStep("fuel"); }} onBack={() => setStep("plate")} />
        )}

        {step === "fuel" && pump && (
          <FuelStep
            pump={pump}
            fuelPrices={station.fuelPrices}
            stationId={station.station.id}
            plate={plate}
            onNext={(f) => { setFuelType(f); setStep("amount"); }}
            onBack={() => setStep(boundPump ? "plate" : "pump")}
          />
        )}

        {step === "amount" && fuelType && (
          <AmountStep
            price={station.fuelPrices.find((f) => f.fuelType === fuelType)!}
            stationId={station.station.id}
            plate={plate}
            onNext={handleAmount}
            onBack={() => setStep("fuel")}
          />
        )}

        {step === "creating" && <p className="hint-text">{t("creating.hint")}</p>}

        {step === "payment" && transaction && accessToken && (
          <PaymentStep
            transaction={transaction}
            accessToken={accessToken}
            iyzicoEnabled={station.iyzicoEnabled}
            estimatedPricePerLiter={estimatedPricePerLiter}
            onPaid={(t) => { setTransaction(t); setStep("dispense"); }}
            onCancel={reset}
          />
        )}

        {step === "iyzico-wait" && transaction && (
          <div>
            <h2>{t("iyzicoWait.title")}</h2>
            <p className="hint-text">{t("iyzicoWait.hint")}</p>
          </div>
        )}

        {step === "dispense" && transaction && <DispenseStep transaction={transaction} targetLiters={targetLiters} />}

        {step === "receipt" && transaction && (
          <ReceiptStep transaction={transaction} accessToken={accessToken} onRestart={reset} />
        )}

        <div className="toolbar" style={{ justifyContent: "center", gap: "1rem" }}>
          {/* Yardim her adimda erisilebilir olmali: musteri en cok odeme/dolum sirasinda
              takilir ve o an ekrandan cikip bir "yardim sayfasi" aramaz. Icinde bulundugu
              pompa ve islem, talebe otomatik iliskilendirilir. */}
          <HelpRequestLink
            pumpId={pump?.id ?? null}
            transactionId={transaction?.id ?? null}
            contactPhone={station.contactPhone}
          />
          <PriceHistoryLink stationId={station.station.id} fuelPrices={station.fuelPrices} />
          <PrivacyNoticeLink stationName={station.station.name} stationAddress={station.station.address} />
        </div>
      </div>

      {idle.warning && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 30 }}>
          <div className="kiosk-card" style={{ width: "min(420px, 92vw)", textAlign: "center" }}>
            <h3>{t("idle.title")}</h3>
            <div className="kiosk-idle-countdown">{idle.secondsLeft}</div>
            <p className="hint-text">{t("idle.body", { seconds: idle.secondsLeft })}</p>
            <button className="primary" style={{ width: "100%", marginTop: "0.5rem" }} onClick={idle.dismiss}>
              {t("idle.continue")}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

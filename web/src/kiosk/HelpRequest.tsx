import { useState } from "react";
import { kioskApi } from "./kioskApi";
import { useKioskLang } from "./i18n";
import { KioskInput } from "./KioskKeyboard";

/**
 * Musteri destek cagrisi.
 *
 * Personelsiz istasyonda karti cekilip yakit akmayan ya da tabancayi calistiramayan
 * bir musterinin baska hicbir yolu yoktu: ekranin ona soyledigi tek sey "istasyon
 * yoneticinizle iletisime gecin" idi - personeli olmayan bir istasyonda.
 *
 * Talep kritik alarma cevrilir ve mevcut bildirim zinciriyle (e-posta/SMS) nobetci
 * personele ulasir; bkz. server/src/services/supportService.ts.
 */

const CATEGORIES = ["dispenser", "payment", "receipt", "other"] as const;
type Category = (typeof CATEGORIES)[number];

export default function HelpRequestLink({
  pumpId,
  transactionId,
  contactPhone,
}: {
  pumpId?: number | null;
  transactionId?: number | null;
  /** Istasyonun kendi numarasi. Tanimli degilse hicbir numara gosterilmez. */
  contactPhone?: string | null;
}) {
  const { t } = useKioskLang();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<Category>("dispenser");
  const [message, setMessage] = useState("");
  const [phone, setPhone] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);

  function reset() {
    setOpen(false);
    setSent(false);
    setFailed(false);
    setMessage("");
    setPhone("");
    setCategory("dispenser");
  }

  async function submit() {
    setSending(true);
    setFailed(false);
    try {
      await kioskApi.createSupportRequest({
        category,
        message: message.trim() || undefined,
        contactPhone: phone.trim() || undefined,
        pumpId: pumpId ?? undefined,
        transactionId: transactionId ?? undefined,
      });
      setSent(true);
    } catch {
      // Musteriye teknik ayrinti gosterilmez; tek anlamli eylem tekrar denemektir.
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button type="button" className="kiosk-privacy-link" onClick={() => setOpen(true)}>
        {t("help.linkLabel")}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 20,
          }}
          onClick={reset}
        >
          <div
            className="kiosk-card"
            style={{ width: "min(560px, 92vw)", maxHeight: "85vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            {sent ? (
              <>
                <h3>{t("help.sentTitle")}</h3>
                {/* Yakit akmayan bir pompa acil servis vakasi degildir: musteriyi 112'ye
                    yonlendirmek onu yanlis yere gonderir ve acil hatti gereksiz mesgul
                    eder. Isletmenin numarasi tanimliysa onu, tanimli degilse hicbir
                    numara gostermeyiz - yanlis numara, numarasizliktan kotudur. */}
                <p className="hint-text">
                  {contactPhone ? t("help.sentBodyWithPhone", { phone: contactPhone }) : t("help.sentBody")}
                </p>
                <div className="kiosk-actions">
                  <span />
                  <button type="button" className="primary" onClick={reset}>
                    {t("help.close")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>{t("help.title")}</h3>
                <p className="hint-text">{t("help.intro")}</p>

                {/* Kiosk'un kendi secenek stili (.option-btn) kullanilir: "ghost" butonlar
                    kiosk'un acik temasinda neredeyse gorunmez kaliyordu ve sikinti icindeki
                    bir musterinin secenekleri okuyamamasi kabul edilemez. */}
                <div style={{ display: "grid", gap: "0.6rem", margin: "1rem 0 1.25rem" }}>
                  {CATEGORIES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`option-btn${category === c ? " selected" : ""}`}
                      aria-pressed={category === c}
                      onClick={() => setCategory(c)}
                      style={{ textAlign: "left", padding: "0.9rem 1rem", fontSize: "1rem" }}
                    >
                      {t(`help.category.${c}`)}
                    </button>
                  ))}
                </div>

                <label htmlFor="help-message">{t("help.messageLabel")}</label>
                {/* Serbest metin: tus takimi musterinin dilinin alfabesini gosterir
                    (bkz. MESSAGE_ALPHABET). Plaka/kod aksine bu bir kimlik degil,
                    musterinin kendi cumlesidir. */}
                <KioskInput
                  layout="message"
                  id="help-message"
                  value={message}
                  onChange={setMessage}
                  placeholder={t("help.messagePlaceholder")}
                  maxLength={500}
                />

                <label htmlFor="help-phone">{t("help.phoneLabel")}</label>
                <KioskInput
                  layout="numeric"
                  id="help-phone"
                  value={phone}
                  onChange={setPhone}
                  maxLength={30}
                  ltr
                />

                {failed && <p className="error-text">{t("help.failed")}</p>}

                <div className="kiosk-actions">
                  <button type="button" onClick={reset}>
                    {t("help.cancel")}
                  </button>
                  <button type="button" className="primary" onClick={submit} disabled={sending}>
                    {sending ? t("help.sending") : t("help.submit")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

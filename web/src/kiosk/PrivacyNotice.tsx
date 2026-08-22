import { useState } from "react";
import { useKioskLang } from "./i18n";

/**
 * KVKK aydinlatma metni. Yalnizca bilgilendirme amaclidir - burada verilen metin bir
 * baslangic sablonudur, istasyonun gercek unvani/iletisim bilgileri ve olasi ek veri
 * isleme faaliyetleriyle birlikte bir hukuk danismanina onaylatilmadan yasal uyum
 * garantisi olarak kullanilmamalidir.
 */
export default function PrivacyNoticeLink({ stationName, stationAddress }: { stationName: string; stationAddress: string }) {
  const { t } = useKioskLang();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className="kiosk-privacy-link" onClick={() => setOpen(true)}>
        {t("privacy.linkLabel")}
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}
          onClick={() => setOpen(false)}
        >
          <div className="kiosk-card" style={{ width: "min(560px, 92vw)", maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{t("privacy.title")}</h3>
            <p className="hint-text">
              {stationAddress ? t("privacy.controllerWithAddress", { station: stationName, address: stationAddress }) : t("privacy.controller", { station: stationName })}
            </p>

            <h4>{t("privacy.legalBasisHeading")}</h4>
            <p className="hint-text">{t("privacy.legalBasisBody")}</p>

            <h4>{t("privacy.dataHeading")}</h4>
            <p className="hint-text">{t("privacy.dataBody")}</p>

            <h4>{t("privacy.purposeHeading")}</h4>
            <p className="hint-text">{t("privacy.purposeBody")}</p>

            <h4>{t("privacy.recipientsHeading")}</h4>
            <p className="hint-text">{t("privacy.recipientsBody")}</p>

            <h4>{t("privacy.retentionHeading")}</h4>
            <p className="hint-text">{t("privacy.retentionBody")}</p>

            <h4>{t("privacy.rightsHeading")}</h4>
            <p className="hint-text">{t("privacy.rightsBody")}</p>

            <h4>{t("privacy.applicationHeading")}</h4>
            <p className="hint-text">{t("privacy.applicationBody", { station: stationName })}</p>

            <h4>{t("privacy.complaintHeading")}</h4>
            <p className="hint-text">{t("privacy.complaintBody")}</p>

            <div className="toolbar" style={{ marginTop: "1rem" }}>
              <div className="spacer" />
              <button className="primary" onClick={() => setOpen(false)}>
                {t("privacy.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

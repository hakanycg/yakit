import { useEffect, useRef, useState, type ReactNode } from "react";
import { RTL_LANGS, useKioskLang, type KioskLang } from "./i18n";

/**
 * Kiosk'a ozel ekran klavyesi.
 *
 * Kiosk'ta isletim sisteminin klavyesi (ekran klavyesi ya da takili fiziksel klavye)
 * ACILMAMALIDIR - bu bir guvenlik meselesidir: OS klavyesi kiosk kabugundan kacis icin
 * kullanilabilir (Win tusu, Ctrl+Alt+Del, tarayici kisayollari, dosya diyaloglari).
 * Musteriye gereken tuslar zaten avuc ici kadar bir kume: rakamlar, Latin harfler ve
 * birkac islem tusu.
 *
 * Bu yuzden kiosk girisleri `readOnly`'dir. readOnly yalnizca mobil/OS klavyesini
 * bastirmakla kalmaz, TAKILI BIR FIZIKSEL KLAVYEDEN yazmayi da engeller - ki
 * personelsiz istasyonda kiosk'a klavye takan biri tam olarak engellenmek istenen
 * seydir. Deger sadece bu bilesenin tuslariyla degisir.
 */

export type KeyboardLayout = "numeric" | "decimal" | "plate" | "code" | "email" | "message";

/** Ozel tuslar; etiketleri dile gore degisir, degerleri degismez. */
type SpecialKey = "backspace" | "clear" | "space" | "done";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
/**
 * Turk plakalari ve kampanya kodlari arayuz dili ne olursa olsun LATIN harflerle
 * yazilir; Arapca arayuzde Arap harfli bir tus takimi vermek plakanin yanlis
 * yazilmasina yol acardi. Bu yuzden harf tuslari dilden BAGIMSIZDIR.
 */
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

/**
 * Serbest metin (destek mesaji) icin DILE GORE alfabe.
 *
 * Plaka, kampanya kodu ve e-posta birer KIMLIKTIR ve her dilde Latin harflerle yazilir;
 * ama "yakit akmiyor" diye yazan bir musteri kendi alfabesini bekler. Rusca yazan
 * musteriye Latin tus takimi vermek, o alani kullanilamaz hale getirirdi.
 */
export const MESSAGE_ALPHABET: Record<KioskLang, string[]> = {
  tr: "ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZ".split(""),
  en: LETTERS,
  de: "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜß".split(""),
  ru: "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ".split(""),
  ar: "ابتثجحخدذرزسشصضطظعغفقكلمنهوىي".split(""),
};

/**
 * Uzun bir alfabeyi DENGELI satirlara boler.
 *
 * Sabit uzunlukta bolmek son satirda tek bir tus birakabiliyordu (ör. 28 harfli Arap
 * alfabesi 9'ar bolununce 9+9+9+1); tuslar flex ile esit paylastigi icin o tek tus tum
 * satiri kaplar ve tus takimi bozuk gorunur. Once satir SAYISI bulunup harfler o
 * satirlara esit dagitiliyor.
 */
function chunk(items: string[], maxPerRow: number): string[][] {
  const rowCount = Math.ceil(items.length / maxPerRow);
  const perRow = Math.ceil(items.length / rowCount);
  const rows: string[][] = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  return rows;
}

export function keyboardRows(layout: KeyboardLayout, lang: KioskLang): string[][] {
  switch (layout) {
    case "numeric":
    case "decimal":
      return [
        ["1", "2", "3"],
        ["4", "5", "6"],
        ["7", "8", "9"],
        layout === "decimal" ? [",", "0"] : ["0"],
      ];
    case "plate":
    case "code":
      return [DIGITS, LETTERS.slice(0, 9), LETTERS.slice(9, 18), LETTERS.slice(18)];
    case "email":
      // Simgeler AYRI satirda: harflerin sonuna eklenince satir 12 tusa cikiyor ve
      // tuslar dokunulamayacak kadar dariliyordu.
      return [DIGITS, LETTERS.slice(0, 9), LETTERS.slice(9, 18), LETTERS.slice(18), ["@", ".", "_", "-"]];
    case "message":
      return [DIGITS, ...chunk(MESSAGE_ALPHABET[lang], 9), [".", ",", "?", "!"]];
  }
}

function KeyButton({ onClick, wide, children, label }: { onClick: () => void; wide?: boolean; children: ReactNode; label?: string }) {
  return (
    <button type="button" className={`kb-key${wide ? " kb-key-wide" : ""}`} onClick={onClick} aria-label={label}>
      {children}
    </button>
  );
}

export function KioskKeypad({
  layout,
  onKey,
  onSpecial,
}: {
  layout: KeyboardLayout;
  onKey: (char: string) => void;
  onSpecial: (key: SpecialKey) => void;
}) {
  const { t, lang } = useKioskLang();
  const allowsSpace = layout === "plate" || layout === "message";

  return (
    // Rakam/plaka/kod tus takimi HER ZAMAN soldan saga dizilir: Arapca arayuzde de
    // plaka ve tutar soldan saga girilir, tus sirasini aynalamak "1 2 3"u "3 2 1" yapar
    // ve musteriyi yanlis tusa gonderirdi. Serbest metin tus takimi ise dilin kendi
    // yonunu izler - Arapca yazan biri icin harfler sagdan sola dizilmeli.
    <div
      className="kiosk-keyboard"
      dir={layout === "message" && RTL_LANGS.includes(lang) ? "rtl" : "ltr"}
      role="group"
      aria-label={t("keyboard.label")}
    >
      {keyboardRows(layout, lang).map((row, i) => (
        <div className="kb-row" key={i}>
          {row.map((char) => (
            <KeyButton key={char} onClick={() => onKey(char)}>
              {char}
            </KeyButton>
          ))}
        </div>
      ))}
      <div className="kb-row">
        {allowsSpace && (
          <KeyButton wide onClick={() => onSpecial("space")} label={t("keyboard.space")}>
            {t("keyboard.space")}
          </KeyButton>
        )}
        <KeyButton onClick={() => onSpecial("backspace")} label={t("keyboard.backspace")}>
          ⌫
        </KeyButton>
        <KeyButton onClick={() => onSpecial("clear")} label={t("keyboard.clear")}>
          {t("keyboard.clear")}
        </KeyButton>
        <KeyButton wide onClick={() => onSpecial("done")} label={t("keyboard.done")}>
          {t("keyboard.done")}
        </KeyButton>
      </div>
    </div>
  );
}

export interface KioskInputProps {
  layout: KeyboardLayout;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  maxLength?: number;
  id?: string;
  /** Plaka gibi her zaman soldan saga okunmasi gereken degerler icin. */
  ltr?: boolean;
  className?: string;
  style?: React.CSSProperties;
  autoFocusKeyboard?: boolean;
}

/**
 * Ekran klavyesiyle calisan kiosk giris alani.
 *
 * Alana dokunulunca klavye ACILIR (sistem klavyesi degil). Klavye alanin hemen altinda,
 * sayfa akisinin icinde acilir - ustte yuzen bir panel, musterinin ne yazdigini goren
 * alani kapatirdi.
 */
export function KioskInput({
  layout,
  value,
  onChange,
  placeholder,
  maxLength,
  id,
  ltr,
  className,
  style,
  autoFocusKeyboard,
}: KioskInputProps) {
  const { t } = useKioskLang();
  const [open, setOpen] = useState(!!autoFocusKeyboard);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Baska bir yere dokununca klavye kapansin: ekranda ayni anda iki klavye durmasin
  // ve musteri "hangi alana yaziyorum?" diye dusunmesin.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function append(char: string) {
    const next = value + char;
    if (maxLength !== undefined && next.length > maxLength) return;
    onChange(next);
  }

  function special(key: SpecialKey) {
    if (key === "backspace") onChange(value.slice(0, -1));
    else if (key === "clear") onChange("");
    else if (key === "space") append(" ");
    else setOpen(false);
  }

  return (
    <div className="kiosk-input-wrap" ref={wrapRef}>
      <input
        id={id}
        value={value}
        /* readOnly: hem OS ekran klavyesini bastirir hem de takili bir fiziksel
           klavyeden yazmayi engeller (bkz. dosya basindaki aciklama). Deger yalnizca
           asagidaki tus takimindan degisir. */
        readOnly
        inputMode="none"
        placeholder={placeholder}
        dir={ltr ? "ltr" : undefined}
        className={className}
        style={style}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
      />
      {open && (
        <>
          <KioskKeypad layout={layout} onKey={append} onSpecial={special} />
          <p className="hint-text kb-hint">{t("keyboard.hint")}</p>
        </>
      )}
    </div>
  );
}

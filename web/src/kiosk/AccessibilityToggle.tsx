import { useKioskLang } from "./i18n";

export default function AccessibilityToggle() {
  const { t, a11y, setA11y } = useKioskLang();

  return (
    <button
      type="button"
      className={a11y ? "active" : ""}
      onClick={() => setA11y(!a11y)}
      title={t(a11y ? "a11y.toggleOffLabel" : "a11y.toggleOnLabel")}
      aria-pressed={a11y}
      style={{ padding: "0.3rem 0.6rem", fontSize: "0.8rem" }}
    >
      🔎
    </button>
  );
}

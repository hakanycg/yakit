/** Ayar kartlarinin basligindaki Aktif/Pasif anahtari - birden fazla ayar sayfasi kullanir. */
export default function StatusToggle({
  checked,
  disabled,
  onChange,
  activeLabel = "Aktif",
  inactiveLabel = "Pasif",
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  activeLabel?: string;
  inactiveLabel?: string;
}) {
  return (
    <label className={`switch-row${disabled ? " disabled" : ""}`}>
      <span className="switch">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
        <span className="track"><span className="thumb" /></span>
      </span>
      <span className="switch-label">{checked ? activeLabel : inactiveLabel}</span>
    </label>
  );
}

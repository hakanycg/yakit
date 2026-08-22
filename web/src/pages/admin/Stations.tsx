import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../shared/api";
import { formatDateTime } from "../../shared/format";
import { useCurrentStationId } from "../../shared/useCurrentStation";
import type { Station } from "../../shared/types";

function syncBadge(s: Station): { label: string; className: string } | null {
  if (!s.agentConfigured) return { label: "Ajan kurulmadı", className: "info" };
  if (!s.lastHeartbeatAt) return { label: "Ajan kurulmadı", className: "info" };
  const minutesAgo = (Date.now() - new Date(s.lastHeartbeatAt).getTime()) / 60000;
  if (minutesAgo < 5) return { label: "Senkron: az önce", className: "resolved" };
  if (minutesAgo < 15) return { label: `Senkron: ${Math.round(minutesAgo)} dk önce`, className: "warning" };
  return { label: `Senkron: ${Math.round(minutesAgo)} dk önce`, className: "critical" };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ş/g, "s").replace(/ı/g, "i").replace(/ö/g, "o").replace(/ç/g, "c")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export default function Stations() {
  const [stations, setStations] = useState<Station[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [, setCurrentStationId] = useCurrentStationId();

  function load() {
    api.get<{ stations: Station[] }>("/api/stations").then((res) => setStations(res.stations));
  }
  useEffect(load, []);

  // Yuzlerce/binlerce istasyon oldugunda kart listesinde tek tek aramak yerine
  // isim/adres/kiosk-adresi/AnyDesk ID'sine gore filtrelenebilsin diye.
  const q = search.trim().toLowerCase();
  const visibleStations = q
    ? stations.filter((s) =>
        [s.name, s.address, s.slug, s.anydeskId ?? ""].some((field) => field.toLowerCase().includes(q))
      )
    : stations;

  async function toggleActive(s: Station) {
    await api.patch(`/api/stations/${s.id}`, { active: !s.active });
    load();
  }

  async function deleteStation(s: Station) {
    const userWarning = (s.userCount ?? 0) > 0 ? ` Bu istasyona bağlı ${s.userCount} kullanıcı hesabı da kalıcı olarak silinecek.` : "";
    if (!confirm(`"${s.name}" istasyonunu kalıcı olarak silmek istediğinize emin misiniz?${userWarning} Bu işlem geri alınamaz.`)) return;
    setError(null);
    try {
      await api.delete(`/api/stations/${s.id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "İstasyon silinemedi.");
    }
  }

  return (
    <div>
      <h2>İstasyonlar</h2>
      {error && <p className="error-text">{error}</p>}
      <div className="toolbar">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="İsim, adres, kiosk adresi veya AnyDesk ID ile ara..."
          style={{ minWidth: 280 }}
        />
        <span className="hint-text">{visibleStations.length} / {stations.length} istasyon</span>
        <div className="spacer" />
        <button className="primary" onClick={() => setShowCreate(true)}>Yeni İstasyon</button>
      </div>

      <div className="grid cols-2">
        {visibleStations.map((s) => (
          <div className="card" key={s.id}>
            <div className="toolbar">
              <strong>{s.name}</strong>
              <span className={`badge ${s.active ? "resolved" : "fault"}`}>{s.active ? "Aktif" : "Pasif"}</span>
              {syncBadge(s) && <span className={`badge ${syncBadge(s)!.className}`}>{syncBadge(s)!.label}</span>}
              <div className="spacer" />
              <button className="ghost" onClick={() => setCurrentStationId(s.id)}>Bu istasyona geç</button>
            </div>
            <p className="hint-text" style={{ margin: "0.25rem 0" }}>{s.address || "Adres girilmemiş"}</p>
            <p className="hint-text" style={{ margin: "0.25rem 0" }}>
              Kiosk: <code>/kiosk/{s.slug}</code>
            </p>
            <AnydeskIdField station={s} onSaved={load} />
            <div className="toolbar" style={{ marginTop: "0.5rem" }}>
              <span className="hint-text">Pompa: {s.pumpCount}</span>
              <span className="hint-text">Kullanıcı: {s.userCount}</span>
              <span className="hint-text" style={{ color: (s.activeAlarms ?? 0) > 0 ? "#f87171" : undefined }}>
                Aktif alarm: {s.activeAlarms}
              </span>
            </div>
            <div className="toolbar" style={{ marginTop: "0.75rem" }}>
              <button onClick={() => toggleActive(s)}>{s.active ? "Devre Dışı Bırak" : "Etkinleştir"}</button>
              {(s.transactionCount ?? 0) === 0 && (
                <button className="danger" onClick={() => deleteStation(s)}>Kalıcı Olarak Sil</button>
              )}
              {s.createdAt && <span className="hint-text">Oluşturulma: {formatDateTime(s.createdAt)}</span>}
            </div>
            {(s.transactionCount ?? 0) > 0 && (
              <p className="hint-text" style={{ marginTop: "0.4rem" }}>
                İşlem kaydı olduğu için kalıcı olarak silinemez; sadece devre dışı bırakılabilir.
              </p>
            )}
            {(s.transactionCount ?? 0) === 0 && (s.userCount ?? 0) > 0 && (
              <p className="hint-text" style={{ marginTop: "0.4rem" }}>
                Silme, buradaki {s.userCount} kullanıcı hesabını da kalıcı olarak kaldırır.
              </p>
            )}
          </div>
        ))}
        {stations.length === 0 && (
          <p className="hint-text">Henüz istasyon yok. "Yeni İstasyon" ile ilk istasyonunuzu oluşturun.</p>
        )}
        {stations.length > 0 && visibleStations.length === 0 && (
          <p className="hint-text">"{search}" ile eşleşen bir istasyon bulunamadı.</p>
        )}
      </div>

      {showCreate && (
        <CreateStationDialog
          onClose={() => setShowCreate(false)}
          onCreated={(station) => {
            load();
            setCurrentStationId(station.id);
          }}
        />
      )}
    </div>
  );
}

/**
 * Kiosk PC'sine kurulan AnyDesk'in ("unattended access" ayarlandiktan sonraki)
 * sabit kimligi - saha kurulumunda bir kere buraya not edilir, ihtiyac aninda
 * (binlerce istasyon arasindan yukaridaki arama kutusuyla bulunup) tek tikla
 * kopyalanip AnyDesk uygulamasina yapistirilarak baglanilir.
 */
function AnydeskIdField({ station, onSaved }: { station: Station; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(station.anydeskId ?? "");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/api/stations/${station.id}`, { anydeskId: value.trim() || null });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kaydedilemedi.");
    } finally {
      setSaving(false);
    }
  }

  async function copy() {
    if (!station.anydeskId) return;
    await navigator.clipboard.writeText(station.anydeskId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (editing) {
    return (
      <div className="toolbar" style={{ margin: "0.25rem 0" }}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="AnyDesk ID (ör. 123 456 789)"
          style={{ maxWidth: 200 }}
        />
        <button onClick={save} disabled={saving}>{saving ? "Kaydediliyor..." : "Kaydet"}</button>
        <button
          className="ghost"
          onClick={() => {
            setEditing(false);
            setValue(station.anydeskId ?? "");
            setError(null);
          }}
        >
          Vazgeç
        </button>
        {error && <span className="error-text">{error}</span>}
      </div>
    );
  }

  return (
    <div className="toolbar" style={{ margin: "0.25rem 0" }}>
      <span className="hint-text">Uzak Erişim (AnyDesk):</span>
      {station.anydeskId ? (
        <>
          <code>{station.anydeskId}</code>
          <button className="ghost" onClick={copy}>{copied ? "Kopyalandı" : "Kopyala"}</button>
        </>
      ) : (
        <span className="hint-text">tanımlanmamış</span>
      )}
      <button className="ghost" onClick={() => setEditing(true)}>{station.anydeskId ? "Düzenle" : "Ekle"}</button>
    </div>
  );
}

function CreateStationDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (s: Station) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [address, setAddress] = useState("");
  const [pumpCount, setPumpCount] = useState(4);
  const [ownerUsername, setOwnerUsername] = useState("");
  const [ownerDisplayName, setOwnerDisplayName] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function handleNameChange(value: string) {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post<{ station: Station }>("/api/stations", { name, slug, address, pumpCount });

      if (ownerUsername) {
        await api.post("/api/users", {
          username: ownerUsername,
          displayName: ownerDisplayName || `${name} Yöneticisi`,
          password: ownerPassword,
          role: "admin",
          stationId: res.station.id,
        });
      }

      onCreated(res.station);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        const details = Array.isArray(err.details) ? ` (${err.details.join(" ")})` : "";
        setError(err.message + details);
      } else {
        setError("İstasyon oluşturulamadı.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 }}>
      <form className="card" style={{ width: "min(460px, 92vw)", maxHeight: "90vh", overflowY: "auto" }} onSubmit={submit}>
        <h3 style={{ marginTop: 0 }}>Yeni İstasyon</h3>

        <label>İstasyon Adı</label>
        <input value={name} onChange={(e) => handleNameChange(e.target.value)} required />

        <label>Kiosk Adresi (slug)</label>
        <input value={slug} onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }} required />
        <p className="hint-text">Kiosk ekranı: /kiosk/{slug || "..."}</p>

        <label>Adres</label>
        <input value={address} onChange={(e) => setAddress(e.target.value)} />

        <label>Pompa Sayısı</label>
        <input type="number" min={1} max={16} value={pumpCount} onChange={(e) => setPumpCount(Number(e.target.value))} />

        <h4 style={{ marginBottom: "0.25rem" }}>İstasyon Yöneticisi (opsiyonel, hemen oluştur)</h4>
        <label>Kullanıcı Adı</label>
        <input value={ownerUsername} onChange={(e) => setOwnerUsername(e.target.value)} placeholder="örn: merkez-admin" />
        <label>Ad Soyad</label>
        <input value={ownerDisplayName} onChange={(e) => setOwnerDisplayName(e.target.value)} />
        <label>Geçici Şifre</label>
        <input type="password" value={ownerPassword} onChange={(e) => setOwnerPassword(e.target.value)} />

        {error && <p className="error-text">{error}</p>}

        <div className="toolbar" style={{ marginTop: "1.25rem" }}>
          <button type="button" onClick={onClose} disabled={submitting}>Vazgeç</button>
          <div className="spacer" />
          <button type="submit" className="primary" disabled={submitting}>{submitting ? "Oluşturuluyor..." : "Oluştur"}</button>
        </div>
      </form>
    </div>
  );
}

import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../shared/api";
import { formatDateTime } from "../../shared/format";
import { useCurrentStationId } from "../../shared/useCurrentStation";
import type { Station } from "../../shared/types";

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
  const [, setCurrentStationId] = useCurrentStationId();

  function load() {
    api.get<{ stations: Station[] }>("/api/stations").then((res) => setStations(res.stations));
  }
  useEffect(load, []);

  async function toggleActive(s: Station) {
    await api.patch(`/api/stations/${s.id}`, { active: !s.active });
    load();
  }

  return (
    <div>
      <h2>Istasyonlar</h2>
      <div className="toolbar">
        <div className="spacer" />
        <button className="primary" onClick={() => setShowCreate(true)}>Yeni Istasyon</button>
      </div>

      <div className="grid cols-2">
        {stations.map((s) => (
          <div className="card" key={s.id}>
            <div className="toolbar">
              <strong>{s.name}</strong>
              <span className={`badge ${s.active ? "resolved" : "fault"}`}>{s.active ? "Aktif" : "Pasif"}</span>
              <div className="spacer" />
              <button className="ghost" onClick={() => setCurrentStationId(s.id)}>Bu istasyona gec</button>
            </div>
            <p className="hint-text" style={{ margin: "0.25rem 0" }}>{s.address || "Adres girilmemis"}</p>
            <p className="hint-text" style={{ margin: "0.25rem 0" }}>
              Kiosk: <code>/kiosk/{s.slug}</code>
            </p>
            <div className="toolbar" style={{ marginTop: "0.5rem" }}>
              <span className="hint-text">Pompa: {s.pumpCount}</span>
              <span className="hint-text">Kullanici: {s.userCount}</span>
              <span className="hint-text" style={{ color: (s.activeAlarms ?? 0) > 0 ? "#f87171" : undefined }}>
                Aktif alarm: {s.activeAlarms}
              </span>
            </div>
            <div className="toolbar" style={{ marginTop: "0.75rem" }}>
              <button onClick={() => toggleActive(s)}>{s.active ? "Devre Disi Birak" : "Etkinlestir"}</button>
              {s.createdAt && <span className="hint-text">Olusturulma: {formatDateTime(s.createdAt)}</span>}
            </div>
          </div>
        ))}
        {stations.length === 0 && (
          <p className="hint-text">Henuz istasyon yok. "Yeni Istasyon" ile ilk istasyonunuzu olusturun.</p>
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
          displayName: ownerDisplayName || `${name} Yoneticisi`,
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
        setError("Istasyon olusturulamadi.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 }}>
      <form className="card" style={{ width: 460, maxHeight: "90vh", overflowY: "auto" }} onSubmit={submit}>
        <h3 style={{ marginTop: 0 }}>Yeni Istasyon</h3>

        <label>Istasyon Adi</label>
        <input value={name} onChange={(e) => handleNameChange(e.target.value)} required />

        <label>Kiosk Adresi (slug)</label>
        <input value={slug} onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }} required />
        <p className="hint-text">Kiosk ekrani: /kiosk/{slug || "..."}</p>

        <label>Adres</label>
        <input value={address} onChange={(e) => setAddress(e.target.value)} />

        <label>Pompa Sayisi</label>
        <input type="number" min={1} max={16} value={pumpCount} onChange={(e) => setPumpCount(Number(e.target.value))} />

        <h4 style={{ marginBottom: "0.25rem" }}>Istasyon Yoneticisi (opsiyonel, hemen olustur)</h4>
        <label>Kullanici Adi</label>
        <input value={ownerUsername} onChange={(e) => setOwnerUsername(e.target.value)} placeholder="orn: merkez-admin" />
        <label>Ad Soyad</label>
        <input value={ownerDisplayName} onChange={(e) => setOwnerDisplayName(e.target.value)} />
        <label>Gecici Sifre</label>
        <input type="password" value={ownerPassword} onChange={(e) => setOwnerPassword(e.target.value)} />

        {error && <p className="error-text">{error}</p>}

        <div className="toolbar" style={{ marginTop: "1.25rem" }}>
          <button type="button" onClick={onClose} disabled={submitting}>Vazgec</button>
          <div className="spacer" />
          <button type="submit" className="primary" disabled={submitting}>{submitting ? "Olusturuluyor..." : "Olustur"}</button>
        </div>
      </form>
    </div>
  );
}

import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../shared/api";
import { formatDateTime } from "../../shared/format";
import type { Station } from "../../shared/types";

/**
 * Dagitim sirketleri (kiracilar).
 *
 * Kiraci acmak ve istasyon atamak TICARI bir karardir (kimin neyi isletecegi,
 * faturalama), bu yuzden yalnizca platform yoneticisine acilir.
 */

interface Tenant {
  id: number;
  name: string;
  slug: string;
  active: boolean;
  stationCount: number;
  userCount: number;
  createdAt: string;
}

export default function Tenants() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [stations, setStations] = useState<Station[]>([]);

  function load() {
    api.get<{ tenants: Tenant[] }>("/api/tenants").then((res) => setTenants(res.tenants));
    api.get<{ stations: Station[] }>("/api/stations").then((res) => setStations(res.stations));
  }

  useEffect(load, []);

  return (
    <div>
      <h2>Dağıtım Şirketleri</h2>
      <p className="hint-text">
        Her dağıtım şirketi yalnızca kendisine atanmış istasyonları görür. Kendi kullanıcılarını, kiosklarını ve
        raporlarını yönetir; başka bir şirketin verisine erişemez.
      </p>

      <div className="grid cols-2">
        <NewTenantCard onCreated={load} />
        <AssignStationCard tenants={tenants} stations={stations} onAssigned={load} />
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Şirket</th>
              <th>Kısa ad</th>
              <th>İstasyon</th>
              <th>Kullanıcı</th>
              <th>Durum</th>
              <th>Oluşturulma</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <TenantRow key={t.id} tenant={t} onChanged={load} />
            ))}
            {tenants.length === 0 && (
              <tr>
                <td colSpan={7} className="hint-text">
                  Henüz dağıtım şirketi yok. Bir şirket açıp istasyon atadığınızda, o şirketin yöneticisi yalnızca
                  kendi istasyonlarını görecek.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TenantRow({ tenant: t, onChanged }: { tenant: Tenant; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await api.patch(`/api/tenants/${t.id}`, { active: !t.active });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <strong>{t.name}</strong>
      </td>
      <td>
        <code>{t.slug}</code>
      </td>
      <td>{t.stationCount}</td>
      <td>{t.userCount}</td>
      <td>
        <span className={`badge ${t.active ? "resolved" : "fault"}`}>{t.active ? "Aktif" : "Pasif"}</span>
      </td>
      <td>{formatDateTime(t.createdAt)}</td>
      <td>
        <button type="button" className="ghost btn-sm" onClick={toggle} disabled={busy}>
          {t.active ? "Devre Dışı Bırak" : "Aktifleştir"}
        </button>
      </td>
    </tr>
  );
}

function NewTenantCard({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/tenants", { name: name.trim(), slug: slug.trim() });
      setName("");
      setSlug("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Şirket oluşturulamadı.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>Yeni Dağıtım Şirketi</h3>

      <label htmlFor="tenant-name">Şirket adı</label>
      <input
        id="tenant-name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          // Kisa ad elle degistirilmediyse isimden turetilir; kullanici yine de duzenleyebilir.
          if (!slug) return;
        }}
        placeholder="ör. Yıldız Akaryakıt Dağıtım A.Ş."
        required
      />

      <label htmlFor="tenant-slug">Kısa ad</label>
      <input
        id="tenant-slug"
        value={slug}
        onChange={(e) => setSlug(e.target.value.toLowerCase())}
        placeholder="ör. yildiz-akaryakit"
        pattern="[a-z0-9-]+"
        required
      />
      <p className="hint-text">Yalnızca küçük harf, rakam ve tire. Sonradan değiştirilemez.</p>

      {error && <p className="error-text">{error}</p>}

      <button type="submit" className="primary" disabled={saving}>
        {saving ? "Oluşturuluyor..." : "Şirket Oluştur"}
      </button>
    </form>
  );
}

/** Istasyonun hangi sirkete ait oldugu; bu atama erisim izolasyonunu dogrudan belirler. */
function AssignStationCard({
  tenants,
  stations,
  onAssigned,
}: {
  tenants: Tenant[];
  stations: Station[];
  onAssigned: () => void;
}) {
  const [stationId, setStationId] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const selected = stations.find((s) => String(s.id) === stationId);

  useEffect(() => {
    setTenantId(selected?.tenantId != null ? String(selected.tenantId) : "");
    setSaved(false);
  }, [stationId, selected?.tenantId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.patch(`/api/tenants/stations/${stationId}`, {
        tenantId: tenantId === "" ? null : Number(tenantId),
      });
      setSaved(true);
      onAssigned();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Atama yapılamadı.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>İstasyon Ata</h3>
      <p className="hint-text" style={{ marginTop: 0 }}>
        Bir istasyonu dağıtım şirketine bağlar. Bu atama, o şirketin yöneticisinin neyi görebileceğini doğrudan
        belirler.
      </p>

      <label htmlFor="assign-station">İstasyon</label>
      <select id="assign-station" value={stationId} onChange={(e) => setStationId(e.target.value)} required>
        <option value="">Seçin...</option>
        {stations.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} {s.code ? `(${s.code})` : ""}
          </option>
        ))}
      </select>

      <label htmlFor="assign-tenant">Dağıtım şirketi</label>
      <select id="assign-tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)} disabled={!stationId}>
        <option value="">Bağlı değil (platformun kendi istasyonu)</option>
        {tenants.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>

      {error && <p className="error-text">{error}</p>}
      {saved && <p className="hint-text">Atama güncellendi.</p>}

      <button type="submit" className="primary" disabled={saving || !stationId}>
        {saving ? "Kaydediliyor..." : "Atamayı Kaydet"}
      </button>
    </form>
  );
}

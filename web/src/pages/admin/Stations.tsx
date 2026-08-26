import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../shared/api";
import { formatDateTime } from "../../shared/format";
import { useCurrentStationId } from "../../shared/useCurrentStation";
import { useEscapeKey } from "../../shared/useEscapeKey";
import type { Pump, Station, StationKiosk } from "../../shared/types";

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
  const [detailId, setDetailId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [, setCurrentStationId] = useCurrentStationId();

  function load() {
    api.get<{ stations: Station[] }>("/api/stations").then((res) => setStations(res.stations));
  }
  useEffect(load, []);

  // Yuzlerce/binlerce istasyon oldugunda kart listesinde tek tek aramak yerine
  // isim/adres/kiosk-adresine gore filtrelenebilsin diye. Kiosk bazinda (AnyDesk ID)
  // arama, her istasyonun kendi kiosk listesi acildiginda orada yapilir - ayri bir
  // AnyDesk kimligini binlerce istasyon arasinda aramak bu sayfanin kapsami disinda.
  const q = search.trim().toLowerCase();
  const visibleStations = q
    ? stations.filter((s) => [s.name, s.address, s.slug, s.code ?? ""].some((field) => field.toLowerCase().includes(q)))
    : stations;

  const detailStation = detailId === null ? null : stations.find((s) => s.id === detailId) ?? null;

  return (
    <div>
      <h2>İstasyonlar</h2>
      <div className="toolbar">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="İsim, adres veya kiosk adresi ile ara..."
          style={{ minWidth: 280 }}
        />
        <span className="hint-text">{visibleStations.length} / {stations.length} istasyon</span>
        <div className="spacer" />
        <button className="primary" onClick={() => setShowCreate(true)}>Yeni İstasyon</button>
      </div>

      {/* Liste: her istasyon tek satir - isim + kod + durum + sayaclar. Detayin
          tamami (adres, kiosk'lar, guvenlik, yonetim) satira tiklaninca acilan
          pencerede; boylece onlarca istasyonda sayfa taranabilir kalir. */}
      <div className="station-list">
        {visibleStations.map((s) => (
          <button type="button" className="station-row" key={s.id} onClick={() => setDetailId(s.id)}>
            <span className="station-row-main">
              <span className="station-row-name">{s.name}</span>
              <span className="station-row-sub">
                <code>{s.code ?? s.slug}</code>
                {s.address && <span className="station-row-address">{s.address}</span>}
              </span>
            </span>
            <span className="station-row-badges">
              <span className={`badge ${s.active ? "resolved" : "fault"}`}>{s.active ? "Aktif" : "Pasif"}</span>
              {syncBadge(s) && <span className={`badge ${syncBadge(s)!.className}`}>{syncBadge(s)!.label}</span>}
              {(s.activeAlarms ?? 0) > 0 && <span className="badge critical">{s.activeAlarms} alarm</span>}
            </span>
            <span className="station-row-counts hint-text">{s.pumpCount ?? 0} pompa</span>
            <span className="station-row-chevron">›</span>
          </button>
        ))}
        {stations.length === 0 && (
          <p className="hint-text">Henüz istasyon yok. "Yeni İstasyon" ile ilk istasyonunuzu oluşturun.</p>
        )}
        {stations.length > 0 && visibleStations.length === 0 && (
          <p className="hint-text">"{search}" ile eşleşen bir istasyon bulunamadı.</p>
        )}
      </div>

      {detailStation && (
        <StationDetailDialog
          station={detailStation}
          onClose={() => setDetailId(null)}
          onChanged={load}
          onDeleted={() => {
            setDetailId(null);
            load();
          }}
          onSwitchTo={() => setCurrentStationId(detailStation.id)}
        />
      )}

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
 * Istasyonun tum detayi - listedeki satira tiklaninca acilan pencere.
 * Bolumler: Isyeri Bilgileri / Ozet / Kiosk Guvenligi / Kiosk Bilgisayarlari /
 * Istasyon Yonetimi.
 */
function StationDetailDialog({
  station: s,
  onClose,
  onChanged,
  onDeleted,
  onSwitchTo,
}: {
  station: Station;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
  onSwitchTo: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  useEscapeKey(onClose);

  async function toggleActive() {
    await api.patch(`/api/stations/${s.id}`, { active: !s.active });
    onChanged();
  }

  async function deleteStation() {
    const userWarning = (s.userCount ?? 0) > 0 ? ` Bu istasyona bağlı ${s.userCount} kullanıcı hesabı da kalıcı olarak silinecek.` : "";
    if (!confirm(`"${s.name}" istasyonunu kalıcı olarak silmek istediğinize emin misiniz?${userWarning} Bu işlem geri alınamaz.`)) return;
    setError(null);
    try {
      await api.delete(`/api/stations/${s.id}`);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "İstasyon silinemedi.");
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="station-card-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="station-name">{s.name}</div>
            <div className="station-card-badges">
              <span className={`badge ${s.active ? "resolved" : "fault"}`}>{s.active ? "Aktif" : "Pasif"}</span>
              {syncBadge(s) && <span className={`badge ${syncBadge(s)!.className}`}>{syncBadge(s)!.label}</span>}
            </div>
          </div>
          <button className="ghost btn-sm" onClick={onSwitchTo}>Bu istasyona geç</button>
          <button className="ghost btn-sm" onClick={onClose} aria-label="Kapat">✕</button>
        </div>

        {error && <p className="error-text">{error}</p>}

        <section className="station-section">
          <div className="station-section-head">
            <h4 className="station-section-title">İşyeri Bilgileri</h4>
          </div>
          <dl className="detail-list">
            <dt>Adres</dt>
            <dd>{s.address || <span className="hint-text">Girilmemiş</span>}</dd>
            <dt>İşletme telefonu</dt>
            <dd><ContactPhoneField station={s} onChanged={onChanged} /></dd>
            <dt>İstasyon kodu</dt>
            <dd><code>{s.code ?? "-"}</code></dd>
            <dt>Kiosk adresi</dt>
            <dd>
              <span className="with-action">
                <code>/kiosk/{s.code ?? s.slug}</code>
                <CopyButton value={`${window.location.origin}/kiosk/${s.code ?? s.slug}`} label="Kopyala" />
              </span>
            </dd>
            <dt>Oluşturulma</dt>
            <dd>{s.createdAt ? formatDateTime(s.createdAt) : "-"}</dd>
          </dl>
        </section>

        <section className="station-section">
          <div className="station-section-head">
            <h4 className="station-section-title">Özet</h4>
          </div>
          <div className="stat-chip-row">
            <span className="stat-chip"><strong>{s.pumpCount ?? 0}</strong> Pompa</span>
            <span className="stat-chip"><strong>{s.userCount ?? 0}</strong> Kullanıcı</span>
            <span className={`stat-chip${(s.activeAlarms ?? 0) > 0 ? " danger" : ""}`}>
              <strong>{s.activeAlarms ?? 0}</strong> Aktif alarm
            </span>
          </div>
        </section>

        <section className="station-section">
          <div className="station-section-head">
            <h4 className="station-section-title">Kiosk Güvenliği</h4>
          </div>
          <KioskTokenToggle station={s} onChanged={onChanged} />
        </section>

        <StationKiosksSection stationId={s.id} stationCode={s.code ?? s.slug} />

        <section className="station-section">
          <div className="station-section-head">
            <h4 className="station-section-title">İstasyon Yönetimi</h4>
          </div>
          <div className="toolbar" style={{ margin: 0 }}>
            <button className="btn-sm" onClick={toggleActive}>{s.active ? "Devre Dışı Bırak" : "Etkinleştir"}</button>
            {(s.transactionCount ?? 0) === 0 && (
              <button className="danger btn-sm" onClick={deleteStation}>Kalıcı Olarak Sil</button>
            )}
          </div>
          {(s.transactionCount ?? 0) > 0 && (
            <p className="hint-text" style={{ margin: "0.4rem 0 0" }}>
              İşlem kaydı olduğu için kalıcı olarak silinemez; sadece devre dışı bırakılabilir.
            </p>
          )}
          {(s.transactionCount ?? 0) === 0 && (s.userCount ?? 0) > 0 && (
            <p className="hint-text" style={{ margin: "0.4rem 0 0" }}>
              Silme, buradaki {s.userCount} kullanıcı hesabını da kalıcı olarak kaldırır.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Bir istasyonda genelde TEK degil, pompa/ada basina AYRI bir fiziksel kiosk PC'si
 * olur. Bu bolum, her birinin uzak masaustu (AnyDesk) kimligini serbest bir etiketle
 * (ör. "Pompa 1-2 Adasi") eslestirip listeler - saha kurulumunda bir kere girilir,
 * ihtiyac aninda tek tikla kopyalanip AnyDesk uygulamasina yapistirilir.
 */
function StationKiosksSection({ stationId, stationCode }: { stationId: number; stationCode: string }) {
  const [kiosks, setKiosks] = useState<StationKiosk[]>([]);
  const [pumps, setPumps] = useState<Pump[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  function load() {
    api.get<{ kiosks: StationKiosk[] }>(`/api/stations/${stationId}/kiosks`).then((res) => {
      setKiosks(res.kiosks);
      setLoaded(true);
    });
  }
  useEffect(load, [stationId]);
  // Kiosk'a pompa baglayabilmek icin bu istasyonun pompa listesi gerekiyor.
  useEffect(() => {
    api.get<{ pumps: Pump[] }>(`/api/pumps?stationId=${stationId}`).then((res) => setPumps(res.pumps)).catch(() => setPumps([]));
  }, [stationId]);

  async function deleteKiosk(k: StationKiosk) {
    if (!confirm(`"${k.label}" kiosk kaydını silmek istediğinize emin misiniz?`)) return;
    await api.delete(`/api/stations/${stationId}/kiosks/${k.id}`);
    load();
  }

  return (
    <section className="station-section">
      <div className="station-section-head">
        <h4 className="station-section-title">Kiosk Bilgisayarları</h4>
        <span className="hint-text" style={{ fontSize: "0.72rem" }}>({kiosks.length})</span>
        <div className="spacer" />
        <button className="ghost btn-sm" onClick={() => setShowAdd(true)}>+ Kiosk Ekle</button>
      </div>

      {kiosks.map((k) => (
        <KioskRow
          key={k.id}
          kiosk={k}
          pumps={pumps}
          stationId={stationId}
          stationCode={stationCode}
          onChanged={load}
          onDelete={() => deleteKiosk(k)}
        />
      ))}
      {loaded && kiosks.length === 0 && (
        <p className="hint-text" style={{ margin: 0 }}>
          Henüz kiosk eklenmemiş. Her pompa/ada için bir kiosk bilgisayarı ekleyin.
        </p>
      )}

      {showAdd && (
        <AddKioskDialog
          stationId={stationId}
          pumps={pumps}
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}
    </section>
  );
}

/** "+ Kiosk Ekle" akisi - kart icinde satir aci lmak yerine odakli bir acilir pencerede. */
function AddKioskDialog({
  stationId,
  pumps,
  onClose,
  onCreated,
}: {
  stationId: number;
  pumps: Pump[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [label, setLabel] = useState("");
  const [anydeskId, setAnydeskId] = useState("");
  const [pumpId, setPumpId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEscapeKey(onClose);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/stations/${stationId}/kiosks`, {
        label,
        anydeskId: anydeskId.trim() || null,
        pumpId: pumpId ? Number(pumpId) : null,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kiosk eklenemedi.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Kiosk Ekle</h3>
        <p className="hint-text" style={{ marginTop: 0 }}>
          İstasyondaki her fiziksel kiosk bilgisayarı için bir kayıt oluşturun. Kayıt eklenince, o cihaza
          uygulayacağınız kurulum adresi listede hazır olur.
        </p>

        <label htmlFor="kiosk-label">Etiket</label>
        <input
          id="kiosk-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="ör. Pompa 1-2 Adası"
          autoFocus
          required
        />
        <p className="hint-text">Personelin hangi cihaz olduğunu anlayacağı serbest bir isim.</p>

        <label htmlFor="kiosk-anydesk">AnyDesk ID (opsiyonel)</label>
        <input
          id="kiosk-anydesk"
          value={anydeskId}
          onChange={(e) => setAnydeskId(e.target.value)}
          placeholder="ör. 123 456 789"
        />
        <p className="hint-text">Uzaktan destek için; sonradan da girilebilir.</p>

        <PumpBindingField id="kiosk-pump" pumps={pumps} value={pumpId} onChange={setPumpId} />

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>Vazgeç</button>
          <div className="spacer" />
          <button type="submit" className="primary" disabled={saving}>{saving ? "Ekleniyor..." : "Ekle"}</button>
        </div>
      </form>
    </div>
  );
}

/**
 * Isletme telefonu - yerinde duzenlenir. Kiosk yardim ekraninda musteriye gosterilen
 * numara budur; bos birakilirsa hicbir numara gosterilmez (yanlis numara,
 * numarasizliktan kotudur).
 */
function ContactPhoneField({ station, onChanged }: { station: Station; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(station.contactPhone ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/api/stations/${station.id}`, { contactPhone: value.trim() || null });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Telefon kaydedilemedi.");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <span className="with-action">
        {station.contactPhone ? <code>{station.contactPhone}</code> : <span className="hint-text">Girilmemiş</span>}
        <button className="ghost btn-sm" onClick={() => setEditing(true)}>Düzenle</button>
      </span>
    );
  }

  return (
    <>
      <span className="with-action">
        <input
          type="tel"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="ör. 0312 555 00 00"
          maxLength={40}
          autoFocus
        />
        <button className="primary btn-sm" onClick={save} disabled={saving}>{saving ? "..." : "Kaydet"}</button>
        <button
          className="ghost btn-sm"
          onClick={() => {
            setEditing(false);
            setValue(station.contactPhone ?? "");
          }}
        >
          Vazgeç
        </button>
      </span>
      {error && <p className="error-text">{error}</p>}
    </>
  );
}

/** Kopyala butonu - kopyalandi geri bildirimi ile. */
function CopyButton({ value, label, disabled }: { value: string; label: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost btn-sm"
      disabled={disabled}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Kopyalandı" : label}
    </button>
  );
}

/**
 * Kiosk'un basinda durdugu pompa. Secilirse musteriye "hangi pompadasiniz?" diye
 * sorulmaz - zaten o pompanin onunde duruyor. Ortak bir odeme noktasindaki kiosk
 * icin bos birakilir.
 */
function PumpBindingField({
  id,
  pumps,
  value,
  onChange,
}: {
  id: string;
  pumps: Pump[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <>
      <label htmlFor={id}>Bağlı pompa (opsiyonel)</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Bağlı değil - müşteri pompayı kendisi seçer</option>
        {pumps.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <p className="hint-text">
        Kiosk tek bir pompanın başında duruyorsa onu seçin: müşteriye pompa sorulmaz, yanlış pompa
        seçilmesi de mümkün olmaz.
      </p>
      {/* Bagli pompa CIHAZ basinadir: sunucu hangi kiosk oldugunu ancak cihaz tokeninden
          anlar. Kiosk sade adresle (/kiosk/KOD) acilirsa bu ayar sessizce etkisiz kalir ve
          "Pompa Secin" ekrani cikmaya devam eder - bunu burada soylemezsek yonetici ayari
          yapip calismadigini sanir. */}
      <p className="hint-text">
        <strong>Not:</strong> bu ayarın çalışması için kiosk, bu kaydın <em>kurulum adresiyle</em>
        (aşağıdaki "Kurulum adresi" düğmesi) açılmış olmalıdır. Sade <code>/kiosk/KOD</code> adresiyle
        açılan bir ekranda sunucu hangi kiosk olduğunu bilemez ve pompa seçme adımı çıkmaya devam eder.
      </p>
    </>
  );
}

function KioskRow({
  kiosk,
  pumps,
  stationId,
  stationCode,
  onChanged,
  onDelete,
}: {
  kiosk: StationKiosk;
  pumps: Pump[];
  stationId: number;
  stationCode: string;
  onChanged: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(kiosk.label);
  const [anydeskId, setAnydeskId] = useState(kiosk.anydeskId ?? "");
  const [pumpId, setPumpId] = useState(kiosk.pumpId ? String(kiosk.pumpId) : "");
  const [saving, setSaving] = useState(false);

  /** Kiosk PC'sinde BIR KEZ acilacak adres; token'i saklayip URL'den temizler. */
  const setupUrl = `${window.location.origin}/kiosk/${stationCode}${kiosk.deviceToken ? `?device=${kiosk.deviceToken}` : ""}`;

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/api/stations/${stationId}/kiosks/${kiosk.id}`, {
        label,
        anydeskId: anydeskId.trim() || null,
        pumpId: pumpId ? Number(pumpId) : null,
      });
      setEditing(false);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="kiosk-item">
        <label htmlFor={`k-label-${kiosk.id}`} style={{ marginTop: 0 }}>Etiket</label>
        <input id={`k-label-${kiosk.id}`} value={label} onChange={(e) => setLabel(e.target.value)} />
        <label htmlFor={`k-anydesk-${kiosk.id}`}>AnyDesk ID</label>
        <input id={`k-anydesk-${kiosk.id}`} value={anydeskId} onChange={(e) => setAnydeskId(e.target.value)} placeholder="ör. 123 456 789" />
        <PumpBindingField id={`k-pump-${kiosk.id}`} pumps={pumps} value={pumpId} onChange={setPumpId} />
        <div className="kiosk-item-actions" style={{ marginTop: "0.6rem" }}>
          <button className="primary btn-sm" onClick={save} disabled={saving}>{saving ? "Kaydediliyor..." : "Kaydet"}</button>
          <button
            className="ghost btn-sm"
            onClick={() => {
              setEditing(false);
              setLabel(kiosk.label);
              setAnydeskId(kiosk.anydeskId ?? "");
              setPumpId(kiosk.pumpId ? String(kiosk.pumpId) : "");
            }}
          >
            Vazgeç
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="kiosk-item">
      <div className="kiosk-item-head">
        <span className="kiosk-item-name">{kiosk.label}</span>
        <span className={`badge ${kiosk.lastSeenAt ? "resolved" : "info"}`}>
          {kiosk.lastSeenAt ? "Kurulu" : "Kurulum bekliyor"}
        </span>
      </div>
      <div className="kiosk-item-meta">
        <span>
          Pompa: {kiosk.pumpId ? (pumps.find((p) => p.id === kiosk.pumpId)?.label ?? `#${kiosk.pumpId}`) : "Müşteri seçer"}
          {kiosk.pumpId && !kiosk.lastSeenAt && (
            <span className="badge warning" style={{ marginLeft: "0.4rem" }}>kurulum adresi uygulanmadı</span>
          )}
        </span>
        <span>AnyDesk: {kiosk.anydeskId ? <code>{kiosk.anydeskId}</code> : "—"}</span>
        <span>Son bağlantı: {kiosk.lastSeenAt ? formatDateTime(kiosk.lastSeenAt) : "—"}</span>
      </div>
      <div className="kiosk-item-actions">
        <CopyButton value={setupUrl} label="Kurulum adresi" disabled={!kiosk.deviceToken} />
        {kiosk.anydeskId && <CopyButton value={kiosk.anydeskId} label="AnyDesk ID" />}
        <button className="ghost btn-sm" onClick={() => setEditing(true)}>Düzenle</button>
        <button className="ghost btn-sm" onClick={onDelete}>Sil</button>
      </div>
    </div>
  );
}

/**
 * Istasyon bazinda "kiosk cihaz tokeni zorunlu mu" anahtari. Bu ozellikten ONCE
 * kurulmus istasyonlarda kapali gelir (kiosk'lar aninda calismaz olmasin diye);
 * yonetici her kiosk'a kurulum adresini uyguladiktan sonra burayi acar.
 */
function KioskTokenToggle({ station, onChanged }: { station: Station; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const required = !!station.requireKioskToken;

  async function toggle() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/api/stations/${station.id}`, { requireKioskToken: !required });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ayar değiştirilemedi.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ margin: "0.35rem 0" }}>
      <label className="check">
        <input type="checkbox" checked={required} disabled={saving} onChange={toggle} />
        <span>Kiosk cihaz tokeni zorunlu</span>
        <span className={`badge ${required ? "resolved" : "warning"}`}>{required ? "Açık" : "Kapalı"}</span>
      </label>
      <p className="hint-text" style={{ margin: "0.15rem 0 0" }}>
        {required
          ? "Yalnızca kurulum adresi uygulanmış kiosk cihazları işlem açabilir."
          : "Kapalıyken bu istasyonun kiosk uçları token olmadan da çalışır. Kiosk'lara kurulum adresini uyguladıktan sonra açın."}
      </p>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function CreateStationDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (s: Station) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [address, setAddress] = useState("");
  const [contactPhone, setContactPhone] = useState("");
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
      const res = await api.post<{ station: Station }>("/api/stations", {
        name,
        slug,
        address,
        contactPhone: contactPhone.trim() || undefined,
        pumpCount,
      });

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
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Yeni İstasyon</h3>

        <label>İstasyon Adı</label>
        <input value={name} onChange={(e) => handleNameChange(e.target.value)} required />

        <label>Kiosk Adresi (slug)</label>
        <input value={slug} onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }} required />
        <p className="hint-text">Kiosk ekranı: /kiosk/{slug || "..."}</p>

        <label>Adres</label>
        <input value={address} onChange={(e) => setAddress(e.target.value)} />

        <label>İşletme Telefonu</label>
        <input type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="ör. 0312 555 00 00" />
        <p className="hint-text">Kiosk yardım ekranında müşteriye gösterilir. Boş bırakılırsa numara gösterilmez.</p>

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

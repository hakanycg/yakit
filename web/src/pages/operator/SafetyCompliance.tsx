import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { formatDateTime } from "../../shared/format";

/**
 * Emniyet Uyum Takvimi: TS 12820'nin pompa kalibrasyonu/damgasi (bkz. Pumps.tsx)
 * DISINDAKI periyodik emniyet kontrolu/sertifika gerektiren maddeleri (yangin
 * sondurucu, paratoner, katodik koruma, tank topraklamasi, elektrik tesisati
 * muayenesi, personel emniyet egitimi). Ayni ilke: "bu kontrol en son ne zaman
 * yapildi, sirada ne var, suresi gecen var mi" - vadesi gecen/yaklasan kalemler
 * icin Alarm Merkezi'nde otomatik alarm olusur (bkz. safetyComplianceService.ts).
 */

interface ComplianceItemMeta {
  type: string;
  label: string;
  standardClause: string;
  defaultIntervalMonths: number;
  intervalIsFromStandard: boolean;
}

interface ComplianceStatus {
  itemType: string;
  label: string;
  standardClause: string;
  lastCompletedAt: string | null;
  nextDueAt: string | null;
  daysRemaining: number | null;
  status: "valid" | "expiring" | "expired" | "unknown";
}

interface ComplianceRecord {
  id: number;
  itemType: string;
  completedAt: string;
  nextDueAt: string;
  intervalMonths: number;
  reference: string | null;
  note: string | null;
  createdAt: string;
}

interface FireExtinguisherRequirement {
  requiredCount: number | null;
  locations: string | null;
}

const STATUS_BADGE: Record<ComplianceStatus["status"], string> = {
  valid: "resolved",
  expiring: "warning",
  expired: "critical",
  unknown: "info",
};

const STATUS_LABEL: Record<ComplianceStatus["status"], string> = {
  valid: "Geçerli",
  expiring: "Yaklaşıyor",
  expired: "Süresi Doldu",
  unknown: "Kayıt yok",
};

export default function SafetyCompliance() {
  const stationId = useEffectiveStationId();
  const [items, setItems] = useState<ComplianceItemMeta[]>([]);
  const [statuses, setStatuses] = useState<ComplianceStatus[]>([]);
  const [target, setTarget] = useState<ComplianceItemMeta | null>(null);
  const [extinguisherRequirement, setExtinguisherRequirement] = useState<FireExtinguisherRequirement | null>(null);
  const [editingRequirement, setEditingRequirement] = useState(false);

  function load() {
    if (stationId === null) return;
    api
      .get<{ items: ComplianceItemMeta[]; status: ComplianceStatus[]; fireExtinguisherRequirement: FireExtinguisherRequirement }>(
        "/api/safety-compliance"
      )
      .then((res) => {
        setItems(res.items);
        setStatuses(res.status);
        setExtinguisherRequirement(res.fireExtinguisherRequirement);
      });
  }
  useEffect(load, [stationId]);

  return (
    <div>
      <h2>Emniyet Uyum Takvimi</h2>
      <p className="hint-text">
        TS 12820'nin pompa kalibrasyonu dışındaki periyodik emniyet kontrolü/sertifika gerektiren maddeleri. Vadesi
        yaklaşan veya geçen bir kalem Alarm Merkezi'nde otomatik olarak bildirilir.
      </p>

      <div className="grid cols-2">
        {items.map((item) => {
          const status = statuses.find((s) => s.itemType === item.type);
          return (
            <div className="card" key={item.type}>
              <div className="card-head">
                <h3 style={{ margin: 0 }}>{item.label}</h3>
                <span className={`badge ${STATUS_BADGE[status?.status ?? "unknown"]}`}>
                  {STATUS_LABEL[status?.status ?? "unknown"]}
                </span>
              </div>
              <p className="hint-text" style={{ marginTop: "0.25rem" }}>
                {item.standardClause}
                {!item.intervalIsFromStandard && " · aralık öneridir, standart kesin sayı vermez"}
              </p>

              {status?.lastCompletedAt ? (
                <p className="hint-text">
                  Son kontrol: {formatDateTime(status.lastCompletedAt).slice(0, 10)} · sıradaki vade:{" "}
                  {status.nextDueAt?.slice(0, 10)}
                  {status.status === "expired" && ` (${Math.abs(status.daysRemaining!)} gün önce doldu)`}
                  {status.status === "expiring" && ` (${status.daysRemaining} gün sonra doluyor)`}
                </p>
              ) : (
                <p className="hint-text">Henüz kayıt girilmemiş.</p>
              )}

              {item.type === "fire_extinguisher" && (
                <p className="hint-text">
                  {extinguisherRequirement?.requiredCount != null
                    ? `Gerekli sayı: ${extinguisherRequirement.requiredCount}${
                        extinguisherRequirement.locations ? ` · Konum: ${extinguisherRequirement.locations}` : ""
                      }`
                    : "Gerekli söndürücü sayısı/konumu henüz girilmemiş."}
                </p>
              )}

              <div className="toolbar" style={{ marginTop: "0.5rem" }}>
                {item.type === "fire_extinguisher" && (
                  <button onClick={() => setEditingRequirement(true)}>Sayı/Konum Düzenle</button>
                )}
                <div className="spacer" />
                <button onClick={() => setTarget(item)}>Kayıt Gir / Geçmiş</button>
              </div>
            </div>
          );
        })}
        {items.length === 0 && <p className="hint-text">Yükleniyor...</p>}
      </div>

      {target && (
        <ComplianceDialog
          item={target}
          onClose={() => {
            setTarget(null);
            load();
          }}
        />
      )}

      {editingRequirement && (
        <FireExtinguisherRequirementDialog
          requirement={extinguisherRequirement}
          onClose={() => {
            setEditingRequirement(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function Modal({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10,
      }}
    >
      <div className="card" style={{ width: "min(620px, 92vw)", maxHeight: "90vh", overflowY: "auto" }}>{children}</div>
    </div>
  );
}

function ComplianceDialog({ item, onClose }: { item: ComplianceItemMeta; onClose: () => void }) {
  const [records, setRecords] = useState<ComplianceRecord[]>([]);
  const [completedAt, setCompletedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [intervalMonths, setIntervalMonths] = useState(String(item.defaultIntervalMonths));
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function loadRecords() {
    api.get<{ records: ComplianceRecord[] }>(`/api/safety-compliance/${item.type}/records`).then((res) => setRecords(res.records));
  }
  useEffect(loadRecords, [item.type]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/safety-compliance/records", {
        itemType: item.type,
        completedAt,
        intervalMonths: Number(intervalMonths),
        reference: reference.trim() || undefined,
        note: note.trim() || undefined,
      });
      setReference("");
      setNote("");
      loadRecords();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kayıt eklenemedi.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal>
      <h3>{item.label}</h3>
      <p className="hint-text" style={{ marginTop: 0 }}>{item.standardClause}</p>

      <form onSubmit={submit}>
        <label htmlFor="sc-date">Kontrolün/eğitimin yapıldığı tarih</label>
        <input id="sc-date" type="date" value={completedAt} onChange={(e) => setCompletedAt(e.target.value)} required />

        <label htmlFor="sc-interval">Sonraki vadeye kadar ay</label>
        <input
          id="sc-interval"
          type="number"
          min={1}
          max={120}
          value={intervalMonths}
          onChange={(e) => setIntervalMonths(e.target.value)}
          required
        />
        {item.intervalIsFromStandard ? (
          <p className="hint-text">TS 12820'nin verdiği taban: {item.defaultIntervalMonths} ay. Daha sık kontrol için kısaltılabilir.</p>
        ) : (
          <p className="hint-text">
            Standart yalnızca "periyodik" diyor, kesin sayı vermiyor — {item.defaultIntervalMonths} ay bir öneridir.
          </p>
        )}

        <label htmlFor="sc-ref">Sertifika / rapor / tutanak no (opsiyonel)</label>
        <input id="sc-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />

        <label htmlFor="sc-note">Not (opsiyonel)</label>
        <input id="sc-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />

        {error && <p className="error-text">{error}</p>}

        <div className="toolbar" style={{ marginTop: "0.75rem" }}>
          <div className="spacer" />
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Kaydediliyor..." : "Kaydet"}
          </button>
        </div>
      </form>

      <h4 style={{ marginTop: "1.5rem" }}>Geçmiş</h4>
      <table>
        <thead>
          <tr>
            <th>Tarih</th>
            <th>Sonraki vade</th>
            <th>Aralık</th>
            <th>Referans</th>
            <th>Not</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id}>
              <td>{r.completedAt.slice(0, 10)}</td>
              <td>{r.nextDueAt.slice(0, 10)}</td>
              <td>{r.intervalMonths} ay</td>
              <td>{r.reference ?? "—"}</td>
              <td>{r.note ?? "—"}</td>
            </tr>
          ))}
          {records.length === 0 && (
            <tr>
              <td colSpan={5} className="hint-text">Henüz kayıt yok.</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="toolbar" style={{ marginTop: "1rem" }}>
        <div className="spacer" />
        <button type="button" onClick={onClose}>Kapat</button>
      </div>
    </Modal>
  );
}

function FireExtinguisherRequirementDialog({
  requirement,
  onClose,
}: {
  requirement: FireExtinguisherRequirement | null;
  onClose: () => void;
}) {
  const [requiredCount, setRequiredCount] = useState(
    requirement?.requiredCount != null ? String(requirement.requiredCount) : ""
  );
  const [locations, setLocations] = useState(requirement?.locations ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.patch("/api/safety-compliance/fire-extinguisher-requirement", {
        requiredCount: requiredCount.trim() ? Number(requiredCount) : null,
        locations: locations.trim() || null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kaydedilemedi.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal>
      <h3>Yangın Söndürücü Sayısı/Konumu</h3>
      <p className="hint-text" style={{ marginTop: 0 }}>
        TS 12820 madde 4.12 — bu istasyonda bulunması gereken söndürücü sayısı ve konumları. Yangın emniyet planınıza
        göre girin; kontrol kayıtlarından bağımsızdır.
      </p>

      <form onSubmit={submit}>
        <label htmlFor="fe-count">Gerekli söndürücü sayısı</label>
        <input
          id="fe-count"
          type="number"
          min={0}
          max={1000}
          value={requiredCount}
          onChange={(e) => setRequiredCount(e.target.value)}
        />

        <label htmlFor="fe-locations">Konumlar (opsiyonel)</label>
        <input
          id="fe-locations"
          value={locations}
          onChange={(e) => setLocations(e.target.value)}
          maxLength={500}
          placeholder="ör. Ofis girişi, pompa 1-2 arası, tank sahası"
        />

        {error && <p className="error-text">{error}</p>}

        <div className="toolbar" style={{ marginTop: "0.75rem" }}>
          <div className="spacer" />
          <button type="button" onClick={onClose}>Vazgeç</button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Kaydediliyor..." : "Kaydet"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

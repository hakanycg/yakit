import { useEffect, useState } from "react";
import { usePumps } from "../../shared/hooks";
import { api, ApiError } from "../../shared/api";
import { PUMP_STATUS_LABEL, FUEL_LABEL, formatDateTime } from "../../shared/format";
import { useAuth } from "../../shared/AuthContext";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { useEscapeKey } from "../../shared/useEscapeKey";
import type { Pump } from "../../shared/types";

interface CalibrationStatus {
  pumpId: number;
  pumpNumber: number;
  lastTestedAt: string | null;
  lastErrorPct: number | null;
  withinTolerance: boolean | null;
  sealValidUntil: string | null;
  sealDaysRemaining: number | null;
  sealStatus: "valid" | "expiring" | "expired" | "unknown";
}

interface Calibration {
  id: number;
  fuelType: string;
  referenceLiters: number;
  meteredLiters: number;
  errorLiters: number;
  errorPct: number;
  withinTolerance: boolean;
  sealValidUntil: string | null;
  sealReference: string | null;
  note: string | null;
  testedAt: string;
  username: string | null;
}

export default function Pumps() {
  const { pumps } = usePumps();
  const { user } = useAuth();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [faultTarget, setFaultTarget] = useState<Pump | null>(null);
  const [maintenanceTarget, setMaintenanceTarget] = useState<Pump | null>(null);
  const [calibrationTarget, setCalibrationTarget] = useState<Pump | null>(null);
  const [calibrationStatus, setCalibrationStatus] = useState<CalibrationStatus[]>([]);
  const [maxErrorPct, setMaxErrorPct] = useState(0.5);
  const stationId = useEffectiveStationId();

  function loadCalibrationStatus() {
    if (stationId === null) return;
    api
      .get<{ pumps: CalibrationStatus[]; maxErrorPct: number }>("/api/pumps/calibration-status")
      .then((res) => {
        setCalibrationStatus(res.pumps);
        setMaxErrorPct(res.maxErrorPct);
      })
      .catch(() => setCalibrationStatus([]));
  }
  useEffect(loadCalibrationStatus, [stationId]);

  const canOperate = user?.role === "admin" || user?.role === "operator" || user?.role === "super_admin";
  const [showEmergencyDialog, setShowEmergencyDialog] = useState(false);

  async function runAction(id: number, action: "start" | "stop" | "reset") {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/api/pumps/${id}/${action}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "İşlem başarısız.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Pompalar</h2>
        <div className="spacer" />
        {canOperate && (
          <button className="danger" onClick={() => setShowEmergencyDialog(true)}>
            🛑 ACİL DURDUR (Tüm İstasyon)
          </button>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="grid cols-2">
        {pumps.map((p) => (
          <div className="card" key={p.id}>
            <div className="toolbar">
              <strong>{p.label}</strong>
              <span className={`badge ${p.status}`}>{PUMP_STATUS_LABEL[p.status]}</span>
              <div className="spacer" />
              <span className="hint-text">Güncelleme: {formatDateTime(p.updatedAt)}</span>
            </div>
            <p className="hint-text">Desteklenen yakıtlar: {p.fuelTypes.map((f) => FUEL_LABEL[f]).join(", ")}</p>
            {p.faultMessage && <p className="error-text">Arıza: {p.faultMessage} ({p.faultCode})</p>}
            {p.currentTransactionId && <p className="hint-text">Aktif işlem: #{p.currentTransactionId}</p>}
            <CalibrationLine status={calibrationStatus.find((c) => c.pumpId === p.id)} maxErrorPct={maxErrorPct} />

            {canOperate && (
              <div className="toolbar" style={{ marginTop: "0.75rem" }}>
                <button disabled={busyId === p.id || p.status === "idle"} onClick={() => runAction(p.id, "start")}>
                  Başlat
                </button>
                <button disabled={busyId === p.id} onClick={() => runAction(p.id, "stop")}>
                  Durdur
                </button>
                <button disabled={busyId === p.id} onClick={() => runAction(p.id, "reset")}>
                  Hizmete Al
                </button>
                <button disabled={busyId === p.id} className="danger" onClick={() => setFaultTarget(p)}>
                  Arızaya Al
                </button>
                <button disabled={busyId === p.id} onClick={() => setMaintenanceTarget(p)}>
                  Bakım Geçmişi
                </button>
                <button disabled={busyId === p.id} onClick={() => setCalibrationTarget(p)}>
                  Ayar / Damga
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {faultTarget && <FaultDialog pump={faultTarget} onClose={() => setFaultTarget(null)} />}
      {maintenanceTarget && <MaintenanceDialog pump={maintenanceTarget} onClose={() => setMaintenanceTarget(null)} />}
      {calibrationTarget && (
        <CalibrationDialog
          pump={calibrationTarget}
          maxErrorPct={maxErrorPct}
          onClose={() => {
            setCalibrationTarget(null);
            loadCalibrationStatus();
          }}
        />
      )}
      {showEmergencyDialog && <EmergencyStopDialog onClose={() => setShowEmergencyDialog(false)} />}
    </div>
  );
}

function EmergencyStopDialog({ onClose }: { onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<number | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post<{ stoppedTransactions: number }>("/api/pumps/emergency-stop-all", reason.trim() ? { reason: reason.trim() } : {});
      setDone(res.stoppedTransactions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Acil durdurma başarısız.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}>
      <div className="card" style={{ width: "min(460px, 92vw)" }}>
        {done === null ? (
          <>
            <h3>Tüm İstasyonu Acil Durdur</h3>
            <p className="error-text">
              Bu işlem istasyondaki TÜM pompaları (boşta olanlar dahil) anında devre dışı bırakır. Hiçbir yeni
              işlem başlatılamaz, aktif dolumlar durdurulur. Yalnızca yangın, dökülme veya benzeri gerçek bir acil
              durumda kullanın.
            </p>
            <label>Sebep (opsiyonel)</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="örn: Yangın şüphesi, pompa 2 civarı" />
            {error && <p className="error-text">{error}</p>}
            <div className="toolbar" style={{ marginTop: "1.25rem" }}>
              <button onClick={onClose} disabled={submitting}>Vazgeç</button>
              <div className="spacer" />
              <button className="danger" onClick={submit} disabled={submitting}>
                {submitting ? "Durduruluyor..." : "Evet, Tüm İstasyonu Durdur"}
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>İstasyon Durduruldu</h3>
            <p>
              Tüm pompalar devre dışı bırakıldı{done > 0 ? ` (${done} aktif işlem sonlandırıldı)` : ""}. Durum
              netleşince her pompayı tek tek "Reset" ile tekrar hizmete alabilirsiniz.
            </p>
            <div className="toolbar" style={{ marginTop: "1.25rem" }}>
              <div className="spacer" />
              <button className="primary" onClick={onClose}>Kapat</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FaultDialog({ pump, onClose }: { pump: Pump; onClose: () => void }) {
  const [faultCode, setFaultCode] = useState("E-101");
  const [faultMessage, setFaultMessage] = useState("Nozul sensörü yanıt vermiyor");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/pumps/${pump.id}/simulate-fault`, { faultCode, faultMessage });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "İşlem başarısız.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 }}>
      <div className="card" style={{ width: "min(420px, 92vw)", maxHeight: "90vh", overflowY: "auto" }}>
        <h3>{pump.label} · Arızaya Al</h3>
        <p className="hint-text">
          Pompa satıştan çekilir ve kiosk bu pompadan yakıt veremez. Devam eden dolum varsa durdurulur ve
          kritik alarm açılır. Pompa, <strong>Hizmete Al</strong> ile geri açılana kadar kapalı kalır.
        </p>
        <label>Arıza Kodu</label>
        <input value={faultCode} onChange={(e) => setFaultCode(e.target.value)} />
        <label>Arıza Mesajı</label>
        <input value={faultMessage} onChange={(e) => setFaultMessage(e.target.value)} />
        {error && <p className="error-text">{error}</p>}
        <div className="toolbar" style={{ marginTop: "1.25rem" }}>
          <button onClick={onClose} disabled={submitting}>Vazgeç</button>
          <div className="spacer" />
          <button className="danger" onClick={submit} disabled={submitting}>
            {submitting ? "Alınıyor..." : "Arızaya Al"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface MaintenanceLog {
  id: number;
  pumpId: number;
  type: "maintenance" | "note";
  description: string;
  username: string | null;
  createdAt: string;
}

const MAINTENANCE_TYPE_LABEL: Record<MaintenanceLog["type"], string> = { maintenance: "Bakım", note: "Not" };

function MaintenanceDialog({ pump, onClose }: { pump: Pump; onClose: () => void }) {
  const [logs, setLogs] = useState<MaintenanceLog[] | null>(null);
  const [type, setType] = useState<MaintenanceLog["type"]>("maintenance");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function load() {
    api.get<{ logs: MaintenanceLog[] }>(`/api/pumps/${pump.id}/maintenance-logs`).then((res) => setLogs(res.logs));
  }
  useEffect(load, [pump.id]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/pumps/${pump.id}/maintenance-logs`, { type, description: description.trim() });
      setDescription("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kayıt eklenemedi.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 }}>
      <div className="card" style={{ width: "min(560px, 92vw)", maxHeight: "90vh", overflowY: "auto" }}>
        <h3>{pump.label} - Bakım Geçmişi</h3>

        <label>Tip</label>
        <select value={type} onChange={(e) => setType(e.target.value as MaintenanceLog["type"])}>
          <option value="maintenance">Bakım (ör. filtre/yağ değişimi, servis)</option>
          <option value="note">Not (genel gözlem)</option>
        </select>
        <label>Açıklama</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="örn: Nozul filtresi değiştirildi" />
        {error && <p className="error-text">{error}</p>}
        <div className="toolbar" style={{ marginTop: "0.75rem" }}>
          <div className="spacer" />
          <button className="primary" disabled={submitting || description.trim().length < 3} onClick={submit}>
            {submitting ? "Ekleniyor..." : "Kayıt Ekle"}
          </button>
        </div>

        <table style={{ marginTop: "1rem" }}>
          <thead>
            <tr><th>Tarih</th><th>Tip</th><th>Açıklama</th><th>Kullanıcı</th></tr>
          </thead>
          <tbody>
            {logs?.map((l) => (
              <tr key={l.id}>
                <td>{formatDateTime(l.createdAt)}</td>
                <td><span className={`badge ${l.type === "maintenance" ? "resolved" : "info"}`}>{MAINTENANCE_TYPE_LABEL[l.type]}</span></td>
                <td>{l.description}</td>
                <td>{l.username ?? "-"}</td>
              </tr>
            ))}
            {logs?.length === 0 && <tr><td colSpan={4} className="hint-text">Kayıt yok.</td></tr>}
            {logs === null && <tr><td colSpan={4} className="hint-text">Yükleniyor...</td></tr>}
          </tbody>
        </table>

        <div className="toolbar" style={{ marginTop: "1rem" }}>
          <button type="button" onClick={onClose}>Kapat</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Pompa kartindaki tek satirlik ayar/damga ozeti.
 *
 * "Hic test edilmedi" ile "test edildi, gecti" ayni sey degildir; ikisi ayri gosterilir.
 */
function CalibrationLine({ status, maxErrorPct }: { status: CalibrationStatus | undefined; maxErrorPct: number }) {
  if (!status || status.lastTestedAt === null) {
    return <p className="hint-text">Ayar testi kaydı yok.</p>;
  }

  const errorText = `%${status.lastErrorPct! > 0 ? "+" : ""}${status.lastErrorPct}`;
  const sealText =
    status.sealStatus === "unknown"
      ? "damga tarihi girilmemiş"
      : status.sealStatus === "expired"
        ? `damga SÜRESİ DOLDU (${Math.abs(status.sealDaysRemaining!)} gün önce)`
        : status.sealStatus === "expiring"
          ? `damga ${status.sealDaysRemaining} gün sonra doluyor`
          : `damga geçerli (${status.sealDaysRemaining} gün)`;

  const bad = status.withinTolerance === false || status.sealStatus === "expired";
  return (
    <p className={bad ? "error-text" : "hint-text"}>
      Ayar: {errorText} {status.withinTolerance ? `(±%${maxErrorPct} içinde)` : `(TOLERANS DIŞI, sınır ±%${maxErrorPct})`} ·{" "}
      {sealText} · son test {formatDateTime(status.lastTestedAt)}
    </p>
  );
}

function CalibrationDialog({ pump, maxErrorPct, onClose }: { pump: Pump; maxErrorPct: number; onClose: () => void }) {
  const [calibrations, setCalibrations] = useState<Calibration[]>([]);
  const [fuelType, setFuelType] = useState(pump.fuelTypes[0] ?? "motorin");
  const [referenceLiters, setReferenceLiters] = useState("10");
  const [meteredLiters, setMeteredLiters] = useState("");
  const [sealValidUntil, setSealValidUntil] = useState("");
  const [sealReference, setSealReference] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEscapeKey(onClose);

  function load() {
    api.get<{ calibrations: Calibration[] }>(`/api/pumps/${pump.id}/calibrations`).then((res) => setCalibrations(res.calibrations));
  }
  useEffect(load, [pump.id]);

  // Canli onizleme: personel kaydetmeden once sonucu gorur.
  const ref = Number(referenceLiters);
  const met = Number(meteredLiters);
  const preview =
    ref > 0 && meteredLiters.trim() !== "" && Number.isFinite(met)
      ? {
          errorPct: Math.round(((met - ref) / ref) * 100 * 1000) / 1000,
          perThousand: Math.round(((met - ref) / ref) * 1000 * 100) / 100,
        }
      : null;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/pumps/${pump.id}/calibrations`, {
        fuelType,
        referenceLiters: ref,
        meteredLiters: met,
        sealValidUntil: sealValidUntil || undefined,
        sealReference: sealReference.trim() || undefined,
        note: note.trim() || undefined,
      });
      setMeteredLiters("");
      setNote("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kaydedilemedi.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="calib-title"
    >
      <div className="card" style={{ width: "min(720px, 94vw)", maxHeight: "90vh", overflowY: "auto" }}>
        <div className="toolbar">
          <h3 id="calib-title" style={{ margin: 0 }}>
            {pump.label} — Ayar Testi ve Damga
          </h3>
          <div className="spacer" />
          <button onClick={onClose}>Kapat</button>
        </div>
        <p className="hint-text" style={{ marginTop: 0 }}>
          Bilinen hacimli bir <strong>ayar kabına</strong> (prover) dolum yapın ve kabın gerçek hacmi ile pompa sayacının
          gösterdiği miktarı girin. Yasal sınır <strong>±%{maxErrorPct}</strong>; aşılırsa kritik alarm oluşur. Ayarı
          kaymış bir pompa yakıt sapma takibinde açıklanamayan bir kayıp olarak görünür ve sızıntı aratır.
        </p>

        <div className="grid cols-2">
          <div>
            <label>Yakıt</label>
            <select value={fuelType} onChange={(e) => setFuelType(e.target.value as typeof fuelType)}>
              {pump.fuelTypes.map((f) => (
                <option key={f} value={f}>
                  {FUEL_LABEL[f]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Ayar Kabı Hacmi (L)</label>
            <input type="number" min={0.1} step="0.001" value={referenceLiters} onChange={(e) => setReferenceLiters(e.target.value)} />
          </div>
          <div>
            <label>Sayaç Okuması (L)</label>
            <input type="number" min={0} step="0.001" value={meteredLiters} onChange={(e) => setMeteredLiters(e.target.value)} autoFocus />
          </div>
          <div>
            <label>Damga Geçerlilik Bitişi</label>
            <input type="date" value={sealValidUntil} onChange={(e) => setSealValidUntil(e.target.value)} />
          </div>
          <div>
            <label>Damga / Muayene Belge No</label>
            <input value={sealReference} onChange={(e) => setSealReference(e.target.value)} />
          </div>
          <div>
            <label>Not</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>

        {preview && (
          <p className={Math.abs(preview.errorPct) > maxErrorPct ? "error-text" : "hint-text"}>
            Hata: <strong>%{preview.errorPct > 0 ? "+" : ""}{preview.errorPct}</strong>{" "}
            {Math.abs(preview.errorPct) > maxErrorPct ? "— TOLERANS DIŞI" : "— tolerans içinde"} · her 1000 L'de{" "}
            <strong>{preview.perThousand > 0 ? "+" : ""}{preview.perThousand} L</strong> fark
            {preview.errorPct > 0 ? " (müşteri aleyhine)" : preview.errorPct < 0 ? " (işletme aleyhine)" : ""}
          </p>
        )}
        {error && <p className="error-text">{error}</p>}

        <div className="toolbar">
          <div className="spacer" />
          <button className="primary" disabled={saving || !preview} onClick={submit}>
            {saving ? "Kaydediliyor..." : "Testi Kaydet"}
          </button>
        </div>

        <h4>Geçmiş Testler</h4>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Tarih</th>
                <th>Yakıt</th>
                <th className="numeric">Kap</th>
                <th className="numeric">Sayaç</th>
                <th className="numeric">Hata</th>
                <th>Damga</th>
                <th>Kaydeden</th>
              </tr>
            </thead>
            <tbody>
              {calibrations.map((c) => (
                <tr key={c.id}>
                  <td>{formatDateTime(c.testedAt)}</td>
                  <td>{FUEL_LABEL[c.fuelType as keyof typeof FUEL_LABEL] ?? c.fuelType}</td>
                  <td className="numeric">{c.referenceLiters}</td>
                  <td className="numeric">{c.meteredLiters}</td>
                  <td className="numeric">
                    <span className={`badge ${c.withinTolerance ? "resolved" : "critical"}`}>
                      %{c.errorPct > 0 ? "+" : ""}
                      {c.errorPct}
                    </span>
                  </td>
                  <td className="hint-text">
                    {c.sealValidUntil ? c.sealValidUntil.slice(0, 10) : "—"}
                    {c.sealReference && <div>{c.sealReference}</div>}
                  </td>
                  <td className="hint-text">{c.username ?? "—"}</td>
                </tr>
              ))}
              {calibrations.length === 0 && (
                <tr>
                  <td colSpan={7} className="hint-text">
                    Henüz ayar testi kaydedilmemiş.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { useActiveAlarms } from "../../shared/hooks";
import { ALARM_SEVERITY_LABEL, formatDateTime } from "../../shared/format";
import { AlertIcon, CheckCircleIcon } from "../../shared/icons";

/**
 * Uyum Panosu: bir denetcinin/isletme sahibinin "istasyon su an mevzuata uygun mu"
 * sorusuna TEK sayfada cevap bulmasi icin, zaten var olan uc ayri kaynagi birlestirir:
 *  - Emniyet Uyum Takvimi (bkz. safetyComplianceService.ts - sondurucu, paratoner,
 *    katodik koruma, topraklama, elektrik tesisati, personel egitimi)
 *  - Pompa kalibrasyon/damga durumu (bkz. pumpCalibrationService.ts)
 *  - Su an acik alarmlar (bkz. alarmService.ts) - yangin/gaz sensorunun tetikledigi
 *    acil durdurma da dahil, cunku sensorun kendi "anlik durumu" ayrica saklanmiyor;
 *    tetiklendiginde zaten bir alarm satiri olusturuyor (bkz. safetyMonitorService.ts).
 *
 * Bu sayfa YENI bir backend endpoint'i GETIRMEZ - tamamen mevcut uclarin birlestirilmis
 * gorunumudur; her bolumun "Detaya git" baglantisi kendi tam sayfasina goturur.
 */

interface ComplianceStatus {
  itemType: string;
  label: string;
  standardClause: string;
  lastCompletedAt: string | null;
  nextDueAt: string | null;
  daysRemaining: number | null;
  status: "valid" | "expiring" | "expired" | "unknown";
}

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

const STATUS_BADGE: Record<string, string> = { valid: "resolved", expiring: "warning", expired: "critical", unknown: "info" };
const STATUS_LABEL: Record<string, string> = { valid: "Geçerli", expiring: "Yaklaşıyor", expired: "Süresi Doldu", unknown: "Kayıt yok" };

export default function ComplianceDashboard() {
  const stationId = useEffectiveStationId();
  const [compliance, setCompliance] = useState<ComplianceStatus[]>([]);
  const [pumps, setPumps] = useState<CalibrationStatus[]>([]);
  const { alarms } = useActiveAlarms();

  useEffect(() => {
    if (stationId === null) return;
    api.get<{ status: ComplianceStatus[] }>("/api/safety-compliance").then((res) => setCompliance(res.status));
    api.get<{ pumps: CalibrationStatus[] }>("/api/pumps/calibration-status").then((res) => setPumps(res.pumps));
  }, [stationId]);

  const complianceProblems = compliance.filter((c) => c.status === "expired" || c.status === "expiring");
  const pumpProblems = pumps.filter((p) => p.withinTolerance === false || p.sealStatus === "expired" || p.sealStatus === "expiring");
  const criticalAlarms = alarms.filter((a) => a.severity === "critical");
  const allClear = complianceProblems.length === 0 && pumpProblems.length === 0 && criticalAlarms.length === 0;

  return (
    <div>
      <h2>Uyum Panosu</h2>
      <p className="hint-text">
        Emniyet Uyum Takvimi, pompa kalibrasyon/damga durumu ve açık alarmların tek bakışta özeti.
      </p>

      <div className={`card`} style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
        <div
          className="stat-icon"
          style={
            allClear
              ? { background: "rgba(74,222,128,0.15)", color: "#4ade80" }
              : { background: "rgba(248,113,113,0.15)", color: "#f87171" }
          }
        >
          {allClear ? <CheckCircleIcon /> : <AlertIcon />}
        </div>
        <div>
          <strong style={{ fontSize: "1.1rem" }}>
            {allClear
              ? "Her şey uygun"
              : `${complianceProblems.length} emniyet kalemi, ${pumpProblems.length} pompa, ${criticalAlarms.length} kritik alarm dikkat istiyor`}
          </strong>
          <p className="hint-text" style={{ margin: 0 }}>
            {allClear
              ? "Emniyet uyum takviminde, pompa kalibrasyon/damgasında ve açık alarmlarda sorun görünmüyor."
              : "Aşağıdaki bölümlerden ayrıntıya inebilirsiniz."}
          </p>
        </div>
      </div>

      <div className="toolbar" style={{ marginTop: "1.5rem" }}>
        <h3 style={{ margin: 0 }}>Emniyet Uyum Takvimi</h3>
        <div className="spacer" />
        <Link to="/operator/emniyet-uyum">
          <button type="button">Detaya git</button>
        </Link>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Kalem</th>
              <th>Madde</th>
              <th>Durum</th>
              <th>Son kontrol</th>
              <th>Sıradaki vade</th>
            </tr>
          </thead>
          <tbody>
            {compliance.map((c) => (
              <tr key={c.itemType}>
                <td>{c.label}</td>
                <td className="hint-text">{c.standardClause}</td>
                <td><span className={`badge ${STATUS_BADGE[c.status]}`}>{STATUS_LABEL[c.status]}</span></td>
                <td>{c.lastCompletedAt ? formatDateTime(c.lastCompletedAt).slice(0, 10) : "—"}</td>
                <td>{c.nextDueAt ? c.nextDueAt.slice(0, 10) : "—"}</td>
              </tr>
            ))}
            {compliance.length === 0 && (
              <tr>
                <td colSpan={5} className="hint-text">Yükleniyor...</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="toolbar" style={{ marginTop: "1.5rem" }}>
        <h3 style={{ margin: 0 }}>Pompa Kalibrasyon / Damga</h3>
        <div className="spacer" />
        <Link to="/operator/pompalar">
          <button type="button">Detaya git</button>
        </Link>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Pompa</th>
              <th>Ayar durumu</th>
              <th>Damga</th>
              <th>Son test</th>
            </tr>
          </thead>
          <tbody>
            {pumps.map((p) => (
              <tr key={p.pumpId}>
                <td>Pompa {p.pumpNumber}</td>
                <td>
                  {p.withinTolerance === null ? (
                    <span className="badge info">Test edilmedi</span>
                  ) : (
                    <span className={`badge ${p.withinTolerance ? "resolved" : "critical"}`}>
                      {p.withinTolerance ? "Tolerans içinde" : "Tolerans dışı"}
                    </span>
                  )}
                </td>
                <td><span className={`badge ${STATUS_BADGE[p.sealStatus]}`}>{STATUS_LABEL[p.sealStatus]}</span></td>
                <td>{p.lastTestedAt ? formatDateTime(p.lastTestedAt).slice(0, 10) : "—"}</td>
              </tr>
            ))}
            {pumps.length === 0 && (
              <tr>
                <td colSpan={4} className="hint-text">Yükleniyor...</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="toolbar" style={{ marginTop: "1.5rem" }}>
        <h3 style={{ margin: 0 }}>Açık Alarmlar</h3>
        <div className="spacer" />
        <Link to="/operator/alarmlar">
          <button type="button">Detaya git</button>
        </Link>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Önem</th>
              <th>Mesaj</th>
              <th>Açıldı</th>
            </tr>
          </thead>
          <tbody>
            {alarms.map((a) => (
              <tr key={a.id}>
                <td><span className={`badge ${a.severity}`}>{ALARM_SEVERITY_LABEL[a.severity]}</span></td>
                <td>{a.message}</td>
                <td>{formatDateTime(a.createdAt)}</td>
              </tr>
            ))}
            {alarms.length === 0 && (
              <tr>
                <td colSpan={3} className="hint-text">Açık alarm yok.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { formatDateTime } from "../../shared/format";

/**
 * Kampanya bildirimi - sadakat sisteminin (loyaltyService.ts) topladigi rizali
 * musteri kitlesine (kiosk'ta makbuz e-posta/telefonu girerken ayri bir onay
 * kutusuyla riza verenler) toplu e-posta/SMS gonderir (bkz. marketingCampaignService.ts).
 *
 * YASAL SINIR: bu ekran yalnizca KENDI riza kaydimizi kontrol eder - Turkiye'de
 * ticari elektronik ileti gonderimi ayrica Ileti Yonetim Sistemi (IYS) kaydi/kontrolu
 * gerektirir (6563 sayili Kanun). Gercek olcekte kullanmadan once hukuk/uyum
 * departmaniyla teyit edilmelidir.
 */

interface Campaign {
  id: number;
  name: string;
  channel: "email" | "sms";
  message: string;
  minDaysSinceVisit: number | null;
  maxDaysSinceVisit: number | null;
  recipientCount: number;
  successCount: number;
  createdAt: string;
  sentAt: string | null;
}

export default function MarketingCampaigns() {
  const stationId = useEffectiveStationId();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  const [name, setName] = useState("");
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [message, setMessage] = useState("");
  const [minDaysSinceVisit, setMinDaysSinceVisit] = useState("");
  const [maxDaysSinceVisit, setMaxDaysSinceVisit] = useState("");
  const [segmentCount, setSegmentCount] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function loadCampaigns() {
    api.get<{ campaigns: Campaign[] }>("/api/marketing-campaigns").then((res) => setCampaigns(res.campaigns));
  }

  useEffect(() => {
    if (stationId === null) return;
    loadCampaigns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationId]);

  useEffect(() => {
    if (stationId === null) return;
    const params = new URLSearchParams({ channel });
    if (minDaysSinceVisit) params.set("minDaysSinceVisit", minDaysSinceVisit);
    if (maxDaysSinceVisit) params.set("maxDaysSinceVisit", maxDaysSinceVisit);
    api.get<{ count: number }>(`/api/marketing-campaigns/segment-preview?${params.toString()}`).then((res) => setSegmentCount(res.count));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationId, channel, minDaysSinceVisit, maxDaysSinceVisit]);

  async function submit() {
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const { campaign } = await api.post<{ campaign: Campaign }>("/api/marketing-campaigns", {
        name,
        channel,
        message,
        minDaysSinceVisit: minDaysSinceVisit ? Number(minDaysSinceVisit) : undefined,
        maxDaysSinceVisit: maxDaysSinceVisit ? Number(maxDaysSinceVisit) : undefined,
      });
      setNotice(`Gönderildi: ${campaign.successCount} / ${campaign.recipientCount} alıcıya ulaştı.`);
      setName("");
      setMessage("");
      loadCampaigns();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kampanya gönderilemedi.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <h2>Kampanya Bildirimi</h2>
      <p className="hint-text">
        Kiosk&rsquo;ta makbuz bilgisi girerken kampanya bildirimlerine açıkça onay veren müşterilere toplu e-posta/SMS gönderir.
      </p>
      <div className="card" style={{ borderLeft: "4px solid var(--warning, #f59e0b)" }}>
        <strong>Yasal uyarı</strong>
        <p className="hint-text" style={{ margin: 0 }}>
          Bu ekran yalnızca kendi rıza kaydımızı kontrol eder. Türkiye&rsquo;de ticari elektronik ileti gönderimi ayrıca İleti Yönetim
          Sistemi (İYS) kaydı/kontrolü gerektirir. Gerçek ölçekte kullanmadan önce hukuk/uyum departmanınızla teyit edin.
        </p>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Yeni Kampanya</h3>
        <label>Kampanya Adı</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="ör. Yaz İndirimi" />

        <div className="toolbar" style={{ marginTop: "0.75rem" }}>
          <div>
            <label>Kanal</label>
            <select value={channel} onChange={(e) => setChannel(e.target.value as "email" | "sms")}>
              <option value="email">E-posta</option>
              <option value="sms">SMS</option>
            </select>
          </div>
          <div>
            <label>En az X gündür gelmeyenler</label>
            <input type="number" min={1} value={minDaysSinceVisit} onChange={(e) => setMinDaysSinceVisit(e.target.value)} placeholder="ör. 30" />
          </div>
          <div>
            <label>Son X gün içinde gelenler</label>
            <input type="number" min={1} value={maxDaysSinceVisit} onChange={(e) => setMaxDaysSinceVisit(e.target.value)} placeholder="ör. 7" />
          </div>
        </div>

        <label style={{ marginTop: "0.75rem", display: "block" }}>Mesaj</label>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} rows={4} style={{ width: "100%" }} />

        <p className="hint-text">
          {segmentCount === null ? "Segment hesaplanıyor..." : `Bu ayarlarla ${segmentCount} müşteriye ulaşılacak.`}
        </p>

        {error && <p className="error-text">{error}</p>}
        {notice && <p className="hint-text" style={{ color: "var(--success, #4ade80)" }}>{notice}</p>}

        <button
          type="button"
          className="primary"
          disabled={sending || !name.trim() || !message.trim() || !segmentCount}
          onClick={() => void submit()}
        >
          {sending ? "Gönderiliyor..." : "Gönder"}
        </button>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Ad</th>
              <th>Kanal</th>
              <th>Alıcı</th>
              <th>Başarılı</th>
              <th>Gönderildi</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.channel === "email" ? "E-posta" : "SMS"}</td>
                <td>{c.recipientCount}</td>
                <td>{c.successCount}</td>
                <td>{c.sentAt ? formatDateTime(c.sentAt) : "—"}</td>
              </tr>
            ))}
            {campaigns.length === 0 && (
              <tr>
                <td colSpan={5} className="hint-text">
                  Henüz kampanya gönderilmedi.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

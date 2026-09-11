import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../shared/api";
import { useAuth } from "../../shared/AuthContext";
import { formatDateTime } from "../../shared/format";

interface ReleaseNote {
  id: number;
  title: string;
  body: string;
  version: string | null;
  createdAt: string;
}

/**
 * "Yenilikler" - super_admin'in platforma bir guncelleme geldiginde yazdigi duyurular
 * (bkz. releaseNoteService.ts). Girisken bir kerelik acilan pencere (ReleaseNotesModal)
 * ile AYNI veriye dayanir; bu sayfa gecmisin TAMAMINI istedigi zaman gorebilecegi
 * kalici liste. Sayfa acildiginda kullanicinin "gorulmemis" sayaci da guncellenir.
 */
export default function ReleaseNotes() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";
  const [notes, setNotes] = useState<ReleaseNote[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [version, setVersion] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.get<{ notes: ReleaseNote[] }>("/api/release-notes").then((res) => setNotes(res.notes));
  }

  useEffect(() => {
    load();
    void api.post("/api/release-notes/mark-seen");
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/release-notes", { title, body, version: version.trim() || undefined });
      setTitle("");
      setBody("");
      setVersion("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Duyuru kaydedilemedi.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    if (!window.confirm("Bu duyuruyu silmek istediğinize emin misiniz?")) return;
    await api.delete(`/api/release-notes/${id}`);
    load();
  }

  return (
    <div>
      <h2>Yenilikler</h2>
      <p className="hint-text">Platforma yapılan güncellemelerin duyuruları.</p>

      {isSuperAdmin && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Yeni Duyuru</h3>
          <form onSubmit={submit}>
            <label htmlFor="rn-title">Başlık</label>
            <input id="rn-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />

            <label htmlFor="rn-version" style={{ marginTop: "0.75rem", display: "block" }}>Versiyon (opsiyonel)</label>
            <input
              id="rn-version"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              maxLength={50}
              placeholder="ör. 1.4.2"
              style={{ maxWidth: "200px" }}
            />

            <label htmlFor="rn-body" style={{ marginTop: "0.75rem", display: "block" }}>Metin</label>
            <textarea id="rn-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} rows={5} style={{ width: "100%" }} required />

            {error && <p className="error-text">{error}</p>}

            <div className="toolbar" style={{ marginTop: "0.75rem" }}>
              <div className="spacer" />
              <button type="submit" className="primary" disabled={saving || !title.trim() || !body.trim()}>
                {saving ? "Yayınlanıyor..." : "Yayınla"}
              </button>
            </div>
          </form>
        </div>
      )}

      {notes.map((note) => (
        <div className="card release-note-item" key={note.id}>
          <div className="release-note-meta">
            <span className="release-note-date hint-text">{formatDateTime(note.createdAt)}</span>
            {isSuperAdmin && (
              <button type="button" onClick={() => void remove(note.id)}>Sil</button>
            )}
          </div>
          <h3 className="release-note-title">
            {note.title}
            {note.version && <span className="release-note-version">v{note.version}</span>}
          </h3>
          <p className="release-note-body">{note.body}</p>
        </div>
      ))}
      {notes.length === 0 && <p className="hint-text">Henüz bir duyuru yok.</p>}
    </div>
  );
}

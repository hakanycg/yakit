import { useEffect, useState } from "react";
import { api } from "./api";
import { formatDateTime } from "./format";

interface ReleaseNote {
  id: number;
  title: string;
  body: string;
  createdAt: string;
}

/**
 * Giriş yapmış bir kullanıcının henüz görmediği "Yenilikler" duyurularını (bkz.
 * releaseNoteService.ts) girişten hemen sonra bir kerelik açılan pencerede gösterir.
 * Kapatınca (veya /admin/yenilikler sayfasını ziyaret edince) bir daha çıkmaz - kritik
 * alarm bildirimi/gelen interkom çağrısıyla AYNI yerde (AppLayout) monte edilir.
 */
export default function ReleaseNotesModal({ enabled }: { enabled: boolean }) {
  const [notes, setNotes] = useState<ReleaseNote[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    api.get<{ notes: ReleaseNote[] }>("/api/release-notes/unseen").then((res) => {
      if (res.notes.length > 0) setNotes(res.notes);
    });
  }, [enabled]);

  function dismiss() {
    setNotes(null);
    void api.post("/api/release-notes/mark-seen");
  }

  if (!notes || notes.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 20,
      }}
    >
      <div className="card" style={{ width: "min(560px, 92vw)", maxHeight: "85vh", overflowY: "auto" }}>
        <h3 style={{ marginTop: 0 }}>Yenilikler</h3>
        {notes.map((note, i) => (
          <div key={note.id} style={{ marginTop: i === 0 ? 0 : "1.25rem", paddingTop: i === 0 ? 0 : "1.25rem", borderTop: i === 0 ? undefined : "1px solid var(--border)" }}>
            <div className="release-note-head">
              <h4>{note.title}</h4>
              <span className="release-note-date hint-text">{formatDateTime(note.createdAt)}</span>
            </div>
            <p className="release-note-body">{note.body}</p>
          </div>
        ))}
        <div className="toolbar" style={{ marginTop: "1.25rem" }}>
          <div className="spacer" />
          <button type="button" className="primary" onClick={dismiss}>Anladım</button>
        </div>
      </div>
    </div>
  );
}

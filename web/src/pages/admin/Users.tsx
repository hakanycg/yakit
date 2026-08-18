import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../shared/api";
import { formatDateTime } from "../../shared/format";
import type { AdminUser, RoleName } from "../../shared/types";
import { useAuth } from "../../shared/AuthContext";

const ROLE_LABEL: Record<RoleName, string> = { admin: "Yonetici", operator: "Operator", viewer: "Izleyici" };

export default function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.get<{ users: AdminUser[] }>("/api/users").then((res) => setUsers(res.users));
  }
  useEffect(load, []);

  async function toggleActive(u: AdminUser) {
    setError(null);
    try {
      await api.patch(`/api/users/${u.id}`, { active: !u.active });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Islem basarisiz.");
    }
  }

  async function changeRole(u: AdminUser, role: RoleName) {
    setError(null);
    try {
      await api.patch(`/api/users/${u.id}`, { role });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Islem basarisiz.");
    }
  }

  async function resetPassword(u: AdminUser) {
    const pwd = prompt(`${u.username} icin gecici sifre girin (en az 10 karakter, buyuk/kucuk harf, rakam, ozel karakter):`);
    if (!pwd) return;
    setError(null);
    try {
      await api.patch(`/api/users/${u.id}`, { resetPassword: pwd });
      load();
      alert("Sifre sifirlandi. Kullanici bir sonraki girişte yeni sifre belirlemek zorunda kalacak.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Islem basarisiz.");
    }
  }

  return (
    <div>
      <h2>Kullanici / Rol Yonetimi</h2>
      {error && <p className="error-text">{error}</p>}
      <div className="toolbar">
        <div className="spacer" />
        <button className="primary" onClick={() => setShowCreate(true)}>Yeni Kullanici</button>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr><th>Kullanici Adi</th><th>Ad Soyad</th><th>Rol</th><th>Durum</th><th>Son Giris</th><th>Islem</th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.username}{u.locked && <span className="badge fault" style={{ marginLeft: 6 }}>Kilitli</span>}</td>
                <td>{u.displayName}</td>
                <td>
                  <select value={u.role} disabled={u.id === me?.id} onChange={(e) => changeRole(u, e.target.value as RoleName)}>
                    {(Object.keys(ROLE_LABEL) as RoleName[]).map((r) => (
                      <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                    ))}
                  </select>
                </td>
                <td><span className={`badge ${u.active ? "resolved" : "fault"}`}>{u.active ? "Aktif" : "Pasif"}</span></td>
                <td>{formatDateTime(u.lastLoginAt)}</td>
                <td>
                  <div className="toolbar" style={{ margin: 0 }}>
                    <button onClick={() => resetPassword(u)}>Sifre Sifirla</button>
                    <button disabled={u.id === me?.id} onClick={() => toggleActive(u)}>
                      {u.active ? "Devre Disi Birak" : "Etkinlestir"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showCreate && <CreateUserDialog onClose={() => setShowCreate(false)} onCreated={load} />}
    </div>
  );
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<RoleName>("operator");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/api/users", { username, displayName, password, role });
      onCreated();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        const details = Array.isArray(err.details) ? ` (${err.details.join(" ")})` : "";
        setError(err.message + details);
      } else {
        setError("Kullanici olusturulamadi.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 }}>
      <form className="card" style={{ width: 420 }} onSubmit={submit}>
        <h3 style={{ marginTop: 0 }}>Yeni Kullanici</h3>
        <label>Kullanici Adi</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} required />
        <label>Ad Soyad</label>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        <label>Gecici Sifre</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <label>Rol</label>
        <select value={role} onChange={(e) => setRole(e.target.value as RoleName)}>
          {(Object.keys(ROLE_LABEL) as RoleName[]).map((r) => (
            <option key={r} value={r}>{ROLE_LABEL[r]}</option>
          ))}
        </select>
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

import { Link } from "react-router-dom";

export default function Unauthorized() {
  return (
    <div className="login-shell">
      <div className="login-card" style={{ textAlign: "center" }}>
        <h2>Erisim Reddedildi</h2>
        <p className="hint-text">Bu sayfayi goruntulemek icin yeterli yetkiniz yok.</p>
        <Link to="/operator">Panele don</Link>
      </div>
    </div>
  );
}

import { Link } from "react-router-dom";

export default function Unauthorized() {
  return (
    <div className="login-shell">
      <div className="login-card" style={{ textAlign: "center" }}>
        <h2>Erişim Reddedildi</h2>
        <p className="hint-text">Bu sayfayı görüntülemek için yeterli yetkiniz yok.</p>
        <Link to="/operator">Panele dön</Link>
      </div>
    </div>
  );
}

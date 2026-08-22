import { Link } from "react-router-dom";
import { useAuth } from "../shared/AuthContext";

export default function ChangePasswordBanner() {
  const { user } = useAuth();
  if (!user?.mustChangePassword) return null;

  return (
    <div style={{ background: "#3a2d1f", color: "#e0b96a", padding: "0.6rem 1.5rem", fontSize: "0.88rem" }}>
      Güvenliğiniz için ilk girişte şifrenizi değiştirmeniz gerekiyor.{" "}
      <Link to="/operator/sifre-degistir" style={{ color: "#e0b96a", textDecoration: "underline" }}>
        Şimdi değiştir
      </Link>
    </div>
  );
}

import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "./AuthContext";
import type { RoleName } from "./types";

export function RequireRole({ roles }: { roles: RoleName[] }) {
  const { user, loading } = useAuth();

  if (loading) return <div className="page-loading">Yukleniyor...</div>;
  if (!user) return <Navigate to="/giris" replace />;
  if (!roles.includes(user.role)) return <Navigate to="/yetkisiz" replace />;

  return <Outlet />;
}

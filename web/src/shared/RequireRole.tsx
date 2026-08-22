import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "./AuthContext";
import type { RoleName } from "./types";

export function RequireRole({ roles }: { roles: RoleName[] }) {
  const { user, loading } = useAuth();

  if (loading) return <div className="page-loading">Yükleniyor...</div>;
  if (!user) return <Navigate to="/giris" replace />;
  // super_admin platformu isleten ekip icindir ve her zaman tum rol kontrollerini gecer.
  if (user.role !== "super_admin" && !roles.includes(user.role)) return <Navigate to="/yetkisiz" replace />;

  return <Outlet />;
}

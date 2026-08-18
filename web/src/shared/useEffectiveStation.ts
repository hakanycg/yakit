import { useAuth } from "./AuthContext";
import { useCurrentStationId } from "./useCurrentStation";

/** super_admin icin ustten secilen istasyonu, diger roller icin kendi istasyonlarini dondurur. */
export function useEffectiveStationId(): number | null {
  const { user } = useAuth();
  const [selected] = useCurrentStationId();
  if (!user) return null;
  return user.role === "super_admin" ? selected : user.stationId;
}

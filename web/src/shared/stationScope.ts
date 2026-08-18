const STORAGE_KEY = "yakit_station_id";

type Listener = (id: number | null) => void;

let currentStationId: number | null = null;
const listeners = new Set<Listener>();

const stored = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
if (stored) currentStationId = Number(stored);

/** super_admin'in su an "bakmakta oldugu" istasyon. Diger roller icin her zaman null (kendi istasyonlarina otomatik baglanirlar). */
export function getCurrentStationId(): number | null {
  return currentStationId;
}

export function setCurrentStationId(id: number | null): void {
  currentStationId = id;
  if (typeof localStorage !== "undefined") {
    if (id !== null) localStorage.setItem(STORAGE_KEY, String(id));
    else localStorage.removeItem(STORAGE_KEY);
  }
  listeners.forEach((l) => l(id));
}

export function subscribeStationId(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function appendStationParam(path: string): string {
  if (currentStationId === null) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}stationId=${currentStationId}`;
}

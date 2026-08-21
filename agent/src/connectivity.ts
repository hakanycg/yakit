/**
 * Merkez sunucuya yapilan son cagrinin basarili olup olmadigina gore basit bir
 * cevrimici/cevrimdisi bayragi tutar. Kiosk/pompa yazilimi, yeni bir islem
 * baslatmadan once GET /status ile buraya bakip merkezle su an haberlesilip
 * haberlesilemedigini (offline mod anahtari) ogrenebilir - bkz. gorev #77.
 */
export interface ConnectivityState {
  online: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
}

let state: ConnectivityState = {
  online: false,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
};

export function markOnline(): void {
  state = { ...state, online: true, lastSuccessAt: new Date().toISOString(), lastError: null };
}

export function markOffline(error: string): void {
  state = { ...state, online: false, lastFailureAt: new Date().toISOString(), lastError: error };
}

export function getConnectivityState(): ConnectivityState {
  return state;
}

/** Testlerde durumu sifirlamak icin. */
export function resetConnectivityState(): void {
  state = { online: false, lastSuccessAt: null, lastFailureAt: null, lastError: null };
}

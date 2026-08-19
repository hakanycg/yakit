const STORAGE_KEY = "yakit_kiosk_pending_tx";

interface PendingKioskTransaction {
  id: number;
  accessToken: string;
}

/** iyzico odeme sayfasina yonlendirmeden hemen once cagrilir; SPA state'i tam sayfa
 *  yonlendirmede kaybolacagi icin islem kimligi ve erisim tokeni yerelde saklanir. */
export function stashPendingKioskTransaction(id: number, accessToken: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, accessToken } satisfies PendingKioskTransaction));
  } catch {
    // localStorage kullanilamiyorsa (ör. gizli sekme kisitlamasi) sessizce yoksay.
  }
}

export function readPendingKioskTransaction(expectedId: number): PendingKioskTransaction | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingKioskTransaction;
    if (parsed.id !== expectedId || typeof parsed.accessToken !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingKioskTransaction(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // yoksay
  }
}

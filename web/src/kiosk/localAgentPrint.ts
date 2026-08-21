export interface ReceiptLine {
  label: string;
  value: string;
}

export interface ReceiptPrintJob {
  title: string;
  lines: ReceiptLine[];
  transactionId: number;
}

// Ajanin varsayilan yerel portu (bkz. agent/.env.example PORT=4500). Istasyon bu
// portu ozellestirdiyse burasi da guncellenmeli - su an icin donanim/ajan dagitimi
// henuz yayginlasmadigindan sabit varsayilan yeterli.
const AGENT_PRINT_URL = "http://127.0.0.1:4500/print";

/**
 * Fisi, ayni kiosk PC'sinde calisan istasyon ajaninin (varsa) gercek termal
 * yazicisina yazdirmayi dener. Ajan calismiyorsa (bugun COGU istasyonda boyle -
 * henuz fiziksel yazici baglanmadi, bkz. printerDriver.ts) veya gercek donanim
 * henuz takilmadiysa false doner; cagiran taraf (ReceiptStep) bu durumda
 * window.print() ile eskisi gibi devam etmelidir - boylece davranista hicbir
 * gerileme olmadan, gercek yazici geldiginde otomatik olarak devreye girer.
 */
export async function tryPrintViaAgent(job: ReceiptPrintJob): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(AGENT_PRINT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (!res.ok) return false;
    const body = (await res.json()) as { printed?: boolean };
    return !!body.printed;
  } catch {
    return false;
  }
}

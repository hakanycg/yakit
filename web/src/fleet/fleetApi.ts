import { ApiError } from "../shared/api";

/**
 * Filo musteri portali icin ayri bir API istemcisi.
 *
 * Paylasilan shared/api.ts kullanilamaz: o istemci personel oturumunun CSRF cerezini
 * (yakit_csrf) okur ve her istege ?stationId= ekler. Portal kullanicisinin ne bir
 * personel oturumu ne de bir istasyon secimi vardir - hangi hesaplari gorecegini
 * sunucu kendi belirler (bkz. server/src/middleware/fleetPortalAuth.ts).
 */

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);

  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrf = readCookie("yakit_fleet_csrf");
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }

  const res = await fetch(path, { ...options, headers, credentials: "same-origin" });
  if (res.status === 204) return undefined as T;

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const message =
      isJson && data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `İstek başarısız (${res.status})`;
    throw new ApiError(message, res.status, isJson ? (data as { details?: unknown }).details : undefined);
  }
  return data as T;
}

export const fleetApi = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export interface PortalAccount {
  accountId: number;
  companyName: string;
  stationId: number;
  stationName: string;
  billingType: "prepaid" | "postpaid";
  balance: number;
  creditLimit: number | null;
  availableAmount: number | null;
  active: boolean;
  plateCount: number;
  lowBalanceThreshold: number | null;
}

export interface PortalUser {
  id: number;
  email: string;
  displayName: string | null;
  mustChangePassword: boolean;
}

export interface StatementRow {
  id: number;
  type: "topup" | "charge" | "refund" | "adjustment";
  amount: number;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
  plate: string | null;
  fuelType: string | null;
  liters: number | null;
  pricePerLiter: number | null;
}

export interface Statement {
  from: string;
  to: string;
  rows: StatementRow[];
  totals: {
    charged: number;
    refunded: number;
    toppedUp: number;
    netSpend: number;
    liters: number;
    fillCount: number;
  };
}

export interface FleetInvoiceLine {
  plate: string;
  fuelType: string;
  liters: number;
  amount: number;
  taxExclusiveAmount: number;
  taxAmount: number;
}

export interface FleetInvoice {
  id: number;
  status: "sent";
  providerInvoiceId: string | null;
  periodStart: string;
  periodEnd: string;
  totalLiters: number;
  taxExclusiveAmount: number;
  taxAmount: number;
  payableAmount: number;
  lines: FleetInvoiceLine[];
  createdAt: string;
}

export interface PlateSummary {
  plate: string;
  fillCount: number;
  liters: number;
  amount: number;
  lastFillAt: string | null;
}

/**
 * Bakiye yukleme TALEBI - yuklemenin kendisi degil.
 *
 * requestedAmount musterinin niyeti, approvedAmount personelin fiilen tahsil ettigi
 * tutardir; ikisi ayni olmak zorunda degildir (eksik havale, farkli tutar). Bakiye
 * yalnizca onay aninda ve approvedAmount kadar artar.
 */
export interface TopupRequest {
  id: number;
  fleetAccountId: number;
  companyName?: string;
  portalUserEmail?: string;
  requestedAmount: number;
  approvedAmount: number | null;
  note: string | null;
  status: "pending" | "approved" | "rejected";
  handledAt: string | null;
  handledNote: string | null;
  createdAt: string;
}

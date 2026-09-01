import { api, kioskRequest } from "../shared/api";
import type { FuelPrice, FuelType, Pump, Station, Transaction } from "../shared/types";

export interface StationResponse {
  station: Station;
  fuelPrices: FuelPrice[];
  pumps: Pump[];
  iyzicoEnabled: boolean;
  /**
   * Bu fiziksel kiosk tek bir pompanin basinda duruyorsa o pompanin kimligi
   * (bkz. server/src/routes/kiosk.ts). Doluysa pompa secme adimi atlanir.
   */
  boundPumpId: number | null;
  /** Isletmenin telefonu; yardim ekraninda musteriye gosterilir. */
  contactPhone: string | null;
}

export const kioskApi = {
  getStation: (slug: string) => api.get<StationResponse>(`/api/kiosk/station/${encodeURIComponent(slug)}`),

  /**
   * Kalp atisi. Kiosk ekrani API'yi normalde yalnizca bir musteri kullanirken cagirir;
   * gece boyu musteri gelmeyen bir istasyonun kiosk'u bu yuzden "olu" gorunurdu.
   * Panel bu sinyale bakarak "kimse kullanmiyor" ile "cihaz dusmus"u ayirir.
   */
  heartbeat: () => api.post<void>("/api/kiosk/heartbeat"),

  /**
   * Musteri destek cagrisi. Cihaz tokeni zorunludur (bkz. routes/kiosk.ts): aksi halde
   * bu uc, istasyon kimligini bilen herkesin nobetci personele SMS yagdirabilecegi bir
   * kanala donusurdu.
   */
  createSupportRequest: (input: {
    category: "payment" | "dispenser" | "receipt" | "other";
    message?: string;
    contactPhone?: string;
    pumpId?: number;
    transactionId?: number;
  }) => api.post<{ alarmRaised: boolean }>("/api/kiosk/support", input),

  recognizePlate: (plate: string) =>
    api.post<{ plate: string; valid: boolean; confidence: number }>("/api/kiosk/lpr/recognize", { plate }),

  createTransaction: (input: {
    pumpId: number;
    plate: string;
    plateSource: "manual" | "lpr";
    fuelType: FuelType;
    amountMode: "amount" | "liters" | "full_tank";
    requestedAmount?: number;
    requestedLiters?: number;
    discountCode?: string;
    redeemPoints?: number;
  }) => api.post<{ transaction: Transaction; accessToken: string }>("/api/kiosk/transactions", input),

  getLoyaltyBalance: (stationId: number, plate: string) =>
    api.get<{ enabled: boolean; points: number; valueTry: number }>(
      `/api/kiosk/loyalty/balance?stationId=${stationId}&plate=${encodeURIComponent(plate)}`
    ),

  // Yanlis yakit onleme: bu plaka bu istasyonda daha once hangi yakit turuyle basariyla
  // dolum yapmis (kendi gecmisimize dayali sinyal) VE/VEYA filo kaydinda tanimli beklenen
  // yakit turu (ilk ziyarette de calisir). hardBlock=true ise uyusmazlikta dolum hic
  // baslamamali (bkz. wrongFuelSettingsService.ts).
  getLastFuelType: (stationId: number, plate: string) =>
    api.get<{ fuelType: FuelType | null; expectedFuelType: FuelType | null; hardBlock: boolean }>(
      `/api/kiosk/plate/last-fuel-type?stationId=${stationId}&plate=${encodeURIComponent(plate)}`
    ),

  // Kod gecersizse backend 404/409 doner - cagiran taraf ApiError'i yakalayip .message'i gostermeli.
  previewDiscountCode: (stationId: number, code: string, fuelType: FuelType, totalAmount: number) =>
    api.post<{ valid: true; discountAmount: number }>("/api/kiosk/discount/preview", { stationId, code, fuelType, totalAmount }),

  getTransaction: (id: number, token: string) =>
    kioskRequest<{ transaction: Transaction }>(`/api/kiosk/transactions/${id}`, token),

  cancel: (id: number, token: string) =>
    kioskRequest<{ transaction: Transaction }>(`/api/kiosk/transactions/${id}/cancel`, token, { method: "POST" }),

  initIyzico: (id: number, token: string) =>
    kioskRequest<{ checkoutFormContent: string; paymentPageUrl: string | null }>(
      `/api/kiosk/transactions/${id}/iyzico/init`,
      token,
      { method: "POST" }
    ),

  sendReceipt: (id: number, token: string, target: { email?: string; phone?: string }) =>
    kioskRequest<{ result: { email?: { sent: boolean; reason?: string }; sms?: { sent: boolean; reason?: string } } }>(
      `/api/kiosk/transactions/${id}/receipt`,
      token,
      { method: "POST", body: JSON.stringify(target) }
    ),

  getFleetAccount: (stationId: number, plate: string) =>
    api.get<{ account: FleetAccountSummary | null }>(`/api/kiosk/fleet-account?stationId=${stationId}&plate=${encodeURIComponent(plate)}`),

  payFleet: (id: number, token: string, fleetAccountId: number, odometerKm?: number) =>
    kioskRequest<{ transaction: Transaction }>(`/api/kiosk/transactions/${id}/pay-fleet`, token, {
      method: "POST",
      body: JSON.stringify({ fleetAccountId, odometerKm }),
    }),

  getPriceHistory: (stationId: number, fuelType: FuelType, days = 30) =>
    api.get<{ history: { pricePerLiter: number; changedAt: string }[] }>(
      `/api/kiosk/fuel-prices/history?stationId=${stationId}&fuelType=${fuelType}&days=${days}`
    ),

  getActiveCampaigns: (stationId: number) =>
    api.get<{ campaigns: { code: string; type: "percent" | "fixed"; value: number; fuelType: FuelType | null }[] }>(
      `/api/kiosk/campaigns/active?stationId=${stationId}`
    ),
};

export interface FleetAccountSummary {
  id: number;
  companyName: string;
  billingType: "prepaid" | "postpaid";
  balance: number;
  creditLimit: number | null;
  availableAmount: number | null;
  active: boolean;
  createdAt: string;
}

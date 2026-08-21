import { api, kioskRequest } from "../shared/api";
import type { FuelPrice, FuelType, Pump, Station, Transaction } from "../shared/types";

export interface StationResponse {
  station: Station;
  fuelPrices: FuelPrice[];
  pumps: Pump[];
  iyzicoEnabled: boolean;
}

export const kioskApi = {
  getStation: (slug: string) => api.get<StationResponse>(`/api/kiosk/station/${encodeURIComponent(slug)}`),

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
  // dolum yapmis - resmi bir ruhsat/tescil kaydi degil, kendi gecmisimize dayali bir sinyal.
  getLastFuelType: (stationId: number, plate: string) =>
    api.get<{ fuelType: FuelType | null }>(
      `/api/kiosk/plate/last-fuel-type?stationId=${stationId}&plate=${encodeURIComponent(plate)}`
    ),

  // Kod gecersizse backend 404/409 doner - cagiran taraf ApiError'i yakalayip .message'i gostermeli.
  previewDiscountCode: (stationId: number, code: string, fuelType: FuelType, totalAmount: number) =>
    api.post<{ valid: true; discountAmount: number }>("/api/kiosk/discount/preview", { stationId, code, fuelType, totalAmount }),

  getTransaction: (id: number, token: string) =>
    kioskRequest<{ transaction: Transaction }>(`/api/kiosk/transactions/${id}`, token),

  pay: (
    id: number,
    token: string,
    card: { cardNumber: string; expiryMonth: number; expiryYear: number; cvv: string; holderName: string }
  ) => kioskRequest<{ transaction: Transaction }>(`/api/kiosk/transactions/${id}/pay`, token, { method: "POST", body: JSON.stringify(card) }),

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
};

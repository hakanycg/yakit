import { api, kioskRequest } from "../shared/api";
import type { FuelPrice, FuelType, Pump, Station, Transaction } from "../shared/types";

export interface StationResponse {
  station: Station;
  fuelPrices: FuelPrice[];
  pumps: Pump[];
}

export const kioskApi = {
  getStation: () => api.get<StationResponse>("/api/kiosk/station"),

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
  }) => api.post<{ transaction: Transaction; accessToken: string }>("/api/kiosk/transactions", input),

  getTransaction: (id: number, token: string) =>
    kioskRequest<{ transaction: Transaction }>(`/api/kiosk/transactions/${id}`, token),

  pay: (
    id: number,
    token: string,
    card: { cardNumber: string; expiryMonth: number; expiryYear: number; cvv: string; holderName: string }
  ) => kioskRequest<{ transaction: Transaction }>(`/api/kiosk/transactions/${id}/pay`, token, { method: "POST", body: JSON.stringify(card) }),

  cancel: (id: number, token: string) =>
    kioskRequest<{ transaction: Transaction }>(`/api/kiosk/transactions/${id}/cancel`, token, { method: "POST" }),
};

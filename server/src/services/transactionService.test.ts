import { describe, expect, it } from "vitest";
import type { TransactionRow } from "../db/types.js";
import { chargeAmount } from "./transactionService.js";

function fakeTransaction(overrides: Partial<TransactionRow>): TransactionRow {
  return {
    id: 1,
    station_id: 1,
    pump_id: 1,
    plate: "34TEST01",
    plate_source: "manual",
    fuel_type: "benzin",
    amount_mode: "amount",
    requested_amount: 500,
    requested_liters: null,
    price_per_liter: 44.5,
    dispensed_liters: 11.24,
    total_amount: 500,
    payment_method: "virtual_card",
    payment_status: "captured",
    payment_reference: null,
    status: "completed",
    kiosk_access_token: "tok",
    operator_user_id: null,
    started_at: null,
    completed_at: new Date().toISOString(),
    cancelled_reason: null,
    receipt_email: null,
    receipt_phone: null,
    receipt_sent_at: null,
    discount_code: null,
    discount_amount: 0,
    loyalty_points_redeemed: 0,
    loyalty_points_earned: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("chargeAmount", () => {
  it("equals total_amount when there is no discount", () => {
    const t = fakeTransaction({ total_amount: 500, discount_amount: 0 });
    expect(chargeAmount(t)).toBe(500);
  });

  it("subtracts the discount from total_amount", () => {
    const t = fakeTransaction({ total_amount: 500, discount_amount: 50 });
    expect(chargeAmount(t)).toBe(450);
  });

  it("never goes negative even if discount_amount somehow exceeds total_amount", () => {
    const t = fakeTransaction({ total_amount: 100, discount_amount: 150 });
    expect(chargeAmount(t)).toBe(0);
  });

  it("leaves total_amount itself untouched (fuel value stays the gross figure)", () => {
    const t = fakeTransaction({ total_amount: 500, discount_amount: 50 });
    chargeAmount(t);
    expect(t.total_amount).toBe(500);
  });
});

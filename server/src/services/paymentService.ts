import { randomBytes } from "node:crypto";

export interface VirtualCardInput {
  cardNumber: string;
  expiryMonth: number;
  expiryYear: number;
  cvv: string;
  holderName: string;
}

export interface PaymentResult {
  success: boolean;
  reference: string;
  message: string;
}

function luhnCheck(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\s+/g, "");
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * Sanal odeme saglayicisi simulasyonu. Gercek bir POS/odeme agi entegrasyonu
 * bulunmadigindan (fiziksel donanim yok), kart dogrulama kurallari (Luhn, son
 * kullanma tarihi, CVV) gercekci sekilde uygulanir ve test kart numaralarinin
 * son 4 hanesi sonucu belirler (....0002 -> red, digerleri -> onay).
 */
export function processVirtualPayment(input: VirtualCardInput, amount: number): PaymentResult {
  const reference = `VPAY-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;

  if (!luhnCheck(input.cardNumber)) {
    return { success: false, reference, message: "Kart numarasi gecersiz." };
  }
  if (!/^\d{3,4}$/.test(input.cvv)) {
    return { success: false, reference, message: "CVV gecersiz." };
  }
  const now = new Date();
  const expiry = new Date(input.expiryYear, input.expiryMonth - 1, 1);
  const endOfExpiryMonth = new Date(expiry.getFullYear(), expiry.getMonth() + 1, 1);
  if (endOfExpiryMonth.getTime() <= now.getTime()) {
    return { success: false, reference, message: "Kartin son kullanma tarihi gecmis." };
  }
  if (amount <= 0) {
    return { success: false, reference, message: "Gecersiz tutar." };
  }
  if (input.cardNumber.replace(/\s+/g, "").endsWith("0002")) {
    return { success: false, reference, message: "Banka islemi reddetti." };
  }

  return { success: true, reference, message: "Odeme onaylandi." };
}

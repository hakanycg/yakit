import { describe, expect, it } from "vitest";
import {
  createTotpChallenge,
  deleteTotpChallenge,
  peekTotpChallenge,
  registerFailedTotpAttempt,
} from "./totpChallengeService.js";

/**
 * 2FA bileti, sifreyi dogru girmis ama kodu henuz girmemis kullaniciyi temsil eder.
 * Buradaki bir hata, ikinci faktoru atlatilabilir hale getirir.
 */

describe("2FA bileti", () => {
  it("her bilet benzersizdir ve kendi kullanicisini tasir", () => {
    const a = createTotpChallenge(1);
    const b = createTotpChallenge(2);
    expect(a).not.toBe(b);
    expect(peekTotpChallenge(a)).toBe(1);
    expect(peekTotpChallenge(b)).toBe(2);
  });

  it("bilinmeyen bilet kullanici dondurmez", () => {
    expect(peekTotpChallenge("uydurma")).toBeNull();
  });

  it("basarili girisin ardindan bilet yakilir", () => {
    const token = createTotpChallenge(7);
    deleteTotpChallenge(token);
    // Bilet tekrar kullanilabilseydi, bir kez dogrulanan kod sonsuza kadar giris
    // yapmaya yeterdi.
    expect(peekTotpChallenge(token)).toBeNull();
  });

  it("hatali kod denemeleri bileti 5. denemede yakar", () => {
    const token = createTotpChallenge(9);
    // Ilk dort deneme bileti ayakta birakir: musteri kodu yanlis girebilir.
    for (let i = 0; i < 4; i += 1) {
      expect(registerFailedTotpAttempt(token)).toBe(true);
      expect(peekTotpChallenge(token)).toBe(9);
    }
    // Besinci denemede biletin isi biter - aksi halde 6 haneli kod sinirsiz denenebilirdi.
    expect(registerFailedTotpAttempt(token)).toBe(false);
    expect(peekTotpChallenge(token)).toBeNull();
  });

  it("yakilmis bilette deneme sayaci calismaz", () => {
    const token = createTotpChallenge(3);
    deleteTotpChallenge(token);
    expect(registerFailedTotpAttempt(token)).toBe(false);
  });

  it("bir biletin denemeleri digerini etkilemez", () => {
    const mine = createTotpChallenge(11);
    const other = createTotpChallenge(12);
    for (let i = 0; i < 5; i += 1) registerFailedTotpAttempt(mine);

    expect(peekTotpChallenge(mine)).toBeNull();
    expect(peekTotpChallenge(other)).toBe(12);
  });
});

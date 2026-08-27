import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWebhook } from "./notificationService.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendWebhook", () => {
  it("secret verilmemisse imza baslikligi eklenmez, govde JSON olarak POST edilir", async () => {
    const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true, status: 200 }) as unknown as Promise<Response>);
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendWebhook("https://ops.example.com/hook", { event: "critical_alarm", alarmId: 1 }, null);

    expect(result).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://ops.example.com/hook");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ event: "critical_alarm", alarmId: 1 }));
    expect((init.headers as Record<string, string>)["X-Yakit-Signature"]).toBeUndefined();
  });

  it("secret verilmisse govde HMAC-SHA256 ile imzalanip X-Yakit-Signature basliginda gonderilir", async () => {
    const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true, status: 200 }) as unknown as Promise<Response>);
    vi.stubGlobal("fetch", fetchMock);
    const payload = { event: "critical_alarm", alarmId: 42 };

    await sendWebhook("https://ops.example.com/hook", payload, "cok-gizli-anahtar");

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    // Imza BAGIMSIZ olarak burada da hesaplanir - sendWebhook'un kendi hesapladigi
    // degeri geri okuyup kendisiyle karsilastirmak (tautoloji) hicbir sey kanitlamaz.
    const expectedSignature = createHmac("sha256", "cok-gizli-anahtar").update(JSON.stringify(payload)).digest("hex");
    expect(headers["X-Yakit-Signature"]).toBe(expectedSignature);
  });

  it("saglayici (alici uc) HTTP hatasi dondururse basarisiz sonuc dondurur", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response));

    const result = await sendWebhook("https://ops.example.com/hook", { event: "critical_alarm" }, null);

    expect(result).toEqual({ sent: false, reason: "Webhook HTTP 500 dondurdu." });
  });

  it("aga baglanti hatasinda basarisiz sonuc dondurur, hata firlatmaz", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("baglanti yok");
      })
    );

    const result = await sendWebhook("https://ops.example.com/hook", { event: "critical_alarm" }, null);

    expect(result).toEqual({ sent: false, reason: "baglanti yok" });
  });
});

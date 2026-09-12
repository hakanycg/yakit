import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// sendWebhook artik fetch'ten once hedefi DNS'ten cozup yerel/ozel araliklara
// karsi kontrol ediyor (SSRF korumasi, bkz. notificationService.ts). Testlerdeki
// "ops.example.com" gercekte cozulmeyebilir (sanal ortamda ENOTFOUND) - bu yuzden
// DNS taklit edilip herkese-acik bir adrese cozuluyor, testler agdan bagimsiz kalir.
const lookupMock = vi.hoisted(() => vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

// sendWebhook artik global fetch() DEGIL, node:http(s)'in request()'ini kullaniyor -
// DNS-rebinding korumasi (dogrulanan adrese sabitlenmis baglanti) ancak boylece
// mumkun (bkz. notificationService.ts'teki requestPinned). Testler bu yuzden
// fetch yerine bu iki modulu taklit eder.
const httpsRequestMock = vi.hoisted(() => vi.fn());
const httpRequestMock = vi.hoisted(() => vi.fn());
vi.mock("node:https", () => ({ request: httpsRequestMock }));
vi.mock("node:http", () => ({ request: httpRequestMock }));

const { sendWebhook } = await import("./notificationService.js");

interface FakeReq {
  end: (body?: unknown) => void;
  on: (event: string, cb: (...args: unknown[]) => void) => FakeReq;
}

/** requestFn'in (options, callback) imzasini taklit eder; callback'e sahte bir yanit verir. */
function mockRequestOnce(statusCode: number): { capturedOptions: Record<string, unknown>; capturedBody: unknown } {
  const captured = { capturedOptions: {} as Record<string, unknown>, capturedBody: undefined as unknown };
  httpsRequestMock.mockImplementationOnce((options: Record<string, unknown>, callback: (res: unknown) => void) => {
    captured.capturedOptions = options;
    const res = {
      statusCode,
      resume: vi.fn(),
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "end") queueMicrotask(() => cb());
        return this;
      },
    };
    queueMicrotask(() => callback(res));
    const req: FakeReq = {
      end: (body?: unknown) => {
        captured.capturedBody = body;
      },
      on: () => req,
    };
    return req;
  });
  return captured;
}

function mockRequestErrorOnce(error: Error): void {
  httpsRequestMock.mockImplementationOnce(() => {
    const req: FakeReq = {
      end: () => {},
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "error") queueMicrotask(() => cb(error));
        return req;
      },
    };
    return req;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  httpsRequestMock.mockReset();
  httpRequestMock.mockReset();
  lookupMock.mockClear();
});

describe("sendWebhook", () => {
  it("secret verilmemisse imza baslikligi eklenmez, govde JSON olarak POST edilir", async () => {
    const captured = mockRequestOnce(200);

    const result = await sendWebhook("https://ops.example.com/hook", { event: "critical_alarm", alarmId: 1 }, null);

    expect(result).toEqual({ sent: true });
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(captured.capturedOptions.method).toBe("POST");
    expect(captured.capturedBody).toBe(JSON.stringify({ event: "critical_alarm", alarmId: 1 }));
    expect((captured.capturedOptions.headers as Record<string, string>)["X-Yakit-Signature"]).toBeUndefined();
  });

  it("secret verilmisse govde HMAC-SHA256 ile imzalanip X-Yakit-Signature basliginda gonderilir", async () => {
    const captured = mockRequestOnce(200);
    const payload = { event: "critical_alarm", alarmId: 42 };

    await sendWebhook("https://ops.example.com/hook", payload, "cok-gizli-anahtar");

    const headers = captured.capturedOptions.headers as Record<string, string>;
    // Imza BAGIMSIZ olarak burada da hesaplanir - sendWebhook'un kendi hesapladigi
    // degeri geri okuyup kendisiyle karsilastirmak (tautoloji) hicbir sey kanitlamaz.
    const expectedSignature = createHmac("sha256", "cok-gizli-anahtar").update(JSON.stringify(payload)).digest("hex");
    expect(headers["X-Yakit-Signature"]).toBe(expectedSignature);
  });

  it("saglayici (alici uc) HTTP hatasi dondururse basarisiz sonuc dondurur", async () => {
    mockRequestOnce(500);

    const result = await sendWebhook("https://ops.example.com/hook", { event: "critical_alarm" }, null);

    expect(result).toEqual({ sent: false, reason: "Webhook HTTP 500 dondurdu." });
  });

  it("aga baglanti hatasinda basarisiz sonuc dondurur, hata firlatmaz", async () => {
    mockRequestErrorOnce(new Error("baglanti yok"));

    const result = await sendWebhook("https://ops.example.com/hook", { event: "critical_alarm" }, null);

    expect(result).toEqual({ sent: false, reason: "baglanti yok" });
  });

  it("gercek baglanti, DOGRULAMA sirasinda cozulen adrese sabitlenir (DNS-rebinding korumasi)", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    const captured = mockRequestOnce(200);

    await sendWebhook("https://ops.example.com/hook", { event: "critical_alarm" }, null);

    // DNS yalnizca BIR KEZ sorgulanir (dogrulama icin); gercek istek kendi ayri bir
    // DNS sorgusu yapmaz - options.lookup, ikinci bir cozumlemeye gitmeden dogrudan
    // dogrulanmis adresi doner.
    expect(lookupMock).toHaveBeenCalledTimes(1);
    const lookupOpt = captured.capturedOptions.lookup as (
      hostname: string,
      opts: unknown,
      cb: (err: Error | null, address: string, family: number) => void
    ) => void;
    const resolved = await new Promise<{ address: string; family: number }>((resolve) => {
      lookupOpt("ops.example.com", {}, (_err, address, family) => resolve({ address, family }));
    });
    expect(resolved).toEqual({ address: "93.184.216.34", family: 4 });
    expect(lookupMock).toHaveBeenCalledTimes(1); // options.lookup'i cagirmak DNS'e tekrar gitmedi
  });

  it("literal yerel IP'ye giden URL DNS'e hic gitmeden engellenir (SSRF)", async () => {
    const result = await sendWebhook("http://127.0.0.1/hook", { event: "critical_alarm" }, null);

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/yerel\/ozel/);
    expect(httpsRequestMock).not.toHaveBeenCalled();
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("literal ozel ag (RFC1918) IP'sine giden URL engellenir (SSRF)", async () => {
    const result = await sendWebhook("http://192.168.1.10/hook", { event: "critical_alarm" }, null);

    expect(result.sent).toBe(false);
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("DNS'ten yerel/ozel adrese cozulen hostname engellenir (SSRF)", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);

    const result = await sendWebhook("https://ic-servis.ornek.com/hook", { event: "critical_alarm" }, null);

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/yerel\/ozel/);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("IPv4-eslesmis IPv6 (::ffff:127.0.0.1) literal adresi engellenir (SSRF)", async () => {
    const result = await sendWebhook("http://[::ffff:127.0.0.1]/hook", { event: "critical_alarm" }, null);

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/yerel\/ozel/);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("IPv4-eslesmis IPv6'nin onaltilik formu (::ffff:7f00:1, new URL()'nin normallestirdigi) engellenir (SSRF)", async () => {
    const result = await sendWebhook("http://[::ffff:7f00:1]/hook", { event: "critical_alarm" }, null);

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/yerel\/ozel/);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("IPv6 benzersiz yerel adres (ULA, fc00::/7) engellenir (SSRF)", async () => {
    const result = await sendWebhook("http://[fd12:3456:789a::1]/hook", { event: "critical_alarm" }, null);

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/yerel\/ozel/);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("http/https disindaki bir sema reddedilir", async () => {
    const result = await sendWebhook("file:///etc/passwd", { event: "critical_alarm" }, null);

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/http\/https/);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });
});

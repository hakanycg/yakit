import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../config.js";
import { _resetFcmTokenCacheForTests, isFcmConfigured, sendFcmMessage } from "./fcmClient.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

describe("isFcmConfigured", () => {
  const original = { projectId: env.FCM_PROJECT_ID, clientEmail: env.FCM_CLIENT_EMAIL, privateKey: env.FCM_PRIVATE_KEY };
  afterEach(() => {
    env.FCM_PROJECT_ID = original.projectId;
    env.FCM_CLIENT_EMAIL = original.clientEmail;
    env.FCM_PRIVATE_KEY = original.privateKey;
  });

  it("uc alan da doluysa true doner", () => {
    env.FCM_PROJECT_ID = "yakit-app";
    env.FCM_CLIENT_EMAIL = "fcm@yakit-app.iam.gserviceaccount.com";
    env.FCM_PRIVATE_KEY = TEST_PRIVATE_KEY_PEM;
    expect(isFcmConfigured()).toBe(true);
  });

  it("herhangi biri eksikse false doner", () => {
    env.FCM_PROJECT_ID = undefined;
    env.FCM_CLIENT_EMAIL = "fcm@yakit-app.iam.gserviceaccount.com";
    env.FCM_PRIVATE_KEY = TEST_PRIVATE_KEY_PEM;
    expect(isFcmConfigured()).toBe(false);
  });
});

describe("sendFcmMessage", () => {
  const original = { projectId: env.FCM_PROJECT_ID, clientEmail: env.FCM_CLIENT_EMAIL, privateKey: env.FCM_PRIVATE_KEY };

  beforeEach(() => {
    env.FCM_PROJECT_ID = "yakit-app";
    env.FCM_CLIENT_EMAIL = "fcm@yakit-app.iam.gserviceaccount.com";
    env.FCM_PRIVATE_KEY = TEST_PRIVATE_KEY_PEM;
    // Modul-seviyesindeki OAuth2 token onbellegi (bkz. fcmClient.ts) testler arasinda
    // KALICIDIR - temizlenmezse bir onceki testte alinan "gecerli" token, sonraki
    // testin bekledigi fetch cagri sayisini (token+send yerine sadece send) bozar.
    _resetFcmTokenCacheForTests();
  });
  afterEach(() => {
    env.FCM_PROJECT_ID = original.projectId;
    env.FCM_CLIENT_EMAIL = original.clientEmail;
    env.FCM_PRIVATE_KEY = original.privateKey;
    vi.unstubAllGlobals();
  });

  it("yapilandirilmamissa fetch'e hic dokunmadan basarisiz doner", async () => {
    env.FCM_PROJECT_ID = undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendFcmMessage("device-token", "Baslik", "Govde");

    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("OAuth2 token alip FCM v1 ucuna dogru istegi atar, basarili yanitta success doner", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "test-access-token", expires_in: 3600 }) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ name: "projects/yakit-app/messages/123" }) } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendFcmMessage("device-token", "Kritik Alarm", "Yangin sensoru tetiklendi");

    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(String(tokenInit.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");

    const [sendUrl, sendInit] = fetchMock.mock.calls[1]! as [string, RequestInit];
    expect(sendUrl).toBe("https://fcm.googleapis.com/v1/projects/yakit-app/messages:send");
    expect((sendInit.headers as Record<string, string>).Authorization).toBe("Bearer test-access-token");
    const body = JSON.parse(String(sendInit.body));
    expect(body.message.token).toBe("device-token");
    expect(body.message.notification).toEqual({ title: "Kritik Alarm", body: "Yangin sensoru tetiklendi" });
  });

  it("FCM UNREGISTERED hatasi dondururse invalidToken=true ile basarisiz doner", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "test-access-token", expires_in: 3600 }) } as unknown as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: { status: "UNREGISTERED", message: "Requested entity was not found." } }),
      } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendFcmMessage("eski-token", "Baslik", "Govde");

    expect(result.success).toBe(false);
    expect(result.invalidToken).toBe(true);
  });

  it("ikinci cagri icin OAuth2 tokenini tekrar almaz (onbellek)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "test-access-token", expires_in: 3600 }) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ name: "x" }) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ name: "y" }) } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await sendFcmMessage("token-1", "T", "B");
    await sendFcmMessage("token-2", "T", "B");

    // Ilk cagri: token + send (2 istek). Ikinci cagri: SADECE send (1 istek) - toplam 3.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

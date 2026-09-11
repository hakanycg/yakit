import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import { logger } from "../utils/logger.js";
import type { UserRow } from "../db/types.js";

const sendFcmMessageMock = vi.hoisted(() => vi.fn());
const isFcmConfiguredMock = vi.hoisted(() => vi.fn(() => true));
vi.mock("../utils/fcmClient.js", () => ({
  sendFcmMessage: sendFcmMessageMock,
  isFcmConfigured: isFcmConfiguredMock,
}));

const { isPushNotificationEnabled, registerDeviceToken, sendPushToUser, unregisterDeviceToken } = await import("./pushNotificationService.js");

let user: UserRow;

beforeEach(() => {
  const station = createTestStation();
  user = createTestUser(station.id, "admin");
  sendFcmMessageMock.mockReset();
  isFcmConfiguredMock.mockReset();
  isFcmConfiguredMock.mockReturnValue(true);
});

describe("isPushNotificationEnabled", () => {
  it("fcmClient.isFcmConfigured() degerini yansitir", () => {
    isFcmConfiguredMock.mockReturnValue(false);
    expect(isPushNotificationEnabled()).toBe(false);
    isFcmConfiguredMock.mockReturnValue(true);
    expect(isPushNotificationEnabled()).toBe(true);
  });
});

describe("registerDeviceToken / unregisterDeviceToken", () => {
  it("bir token kaydeder ve sonra siler", () => {
    registerDeviceToken(user.id, "device-token-1", "android");
    const row = db.prepare("SELECT * FROM device_push_tokens WHERE token = ?").get("device-token-1") as { user_id: number } | undefined;
    expect(row?.user_id).toBe(user.id);

    unregisterDeviceToken(user.id, "device-token-1");
    const afterDelete = db.prepare("SELECT * FROM device_push_tokens WHERE token = ?").get("device-token-1");
    expect(afterDelete).toBeUndefined();
  });

  it("ayni token tekrar kaydedilirse (ör. baska kullanicidan) kullaniciyi gunceller, cift satir olusturmaz", () => {
    const other = createTestUser(user.station_id, "operator");
    registerDeviceToken(user.id, "shared-device-token", "ios");
    registerDeviceToken(other.id, "shared-device-token", "ios");

    const rows = db.prepare("SELECT * FROM device_push_tokens WHERE token = ?").all("shared-device-token") as { user_id: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(other.id);
  });

  it("token baska bir kullaniciya devredildiginde izlenebilir olsun diye uyari loglar", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const other = createTestUser(user.station_id, "operator");

    registerDeviceToken(user.id, "device-devir", "android");
    expect(warnSpy).not.toHaveBeenCalled(); // ilk kayitta devir yok

    registerDeviceToken(other.id, "device-devir", "android");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ previousUserId: user.id, newUserId: other.id }),
      expect.stringContaining("devredildi")
    );

    warnSpy.mockRestore();
  });

  it("ayni kullanici kendi token'ini tekrar kaydederse (devir degil) uyari loglamaz", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);

    registerDeviceToken(user.id, "device-tekrar", "android");
    registerDeviceToken(user.id, "device-tekrar", "android");

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("sendPushToUser", () => {
  it("FCM yapilandirilmamissa hicbir sey yapmaz", async () => {
    isFcmConfiguredMock.mockReturnValue(false);
    registerDeviceToken(user.id, "device-token-2", "android");

    await sendPushToUser(user.id, "Baslik", "Govde");

    expect(sendFcmMessageMock).not.toHaveBeenCalled();
  });

  it("kayitli token yoksa FCM'e hic istek atmaz", async () => {
    await sendPushToUser(user.id, "Baslik", "Govde");
    expect(sendFcmMessageMock).not.toHaveBeenCalled();
  });

  it("kullanicinin TUM cihazlarina gonderir", async () => {
    registerDeviceToken(user.id, "device-a", "android");
    registerDeviceToken(user.id, "device-b", "ios");
    sendFcmMessageMock.mockResolvedValue({ success: true });

    await sendPushToUser(user.id, "Kritik Alarm", "Yangin sensoru tetiklendi");

    expect(sendFcmMessageMock).toHaveBeenCalledTimes(2);
    const calledTokens = sendFcmMessageMock.mock.calls.map((c: unknown[]) => c[0]).sort();
    expect(calledTokens).toEqual(["device-a", "device-b"]);
  });

  it("gecersiz bulunan token'i veritabanindan siler, diger token'lara dokunmaz", async () => {
    registerDeviceToken(user.id, "valid-device", "android");
    registerDeviceToken(user.id, "stale-device", "android");
    sendFcmMessageMock.mockImplementation(async (token: string) =>
      token === "stale-device" ? { success: false, invalidToken: true } : { success: true }
    );

    await sendPushToUser(user.id, "Baslik", "Govde");

    const remaining = db.prepare<[number], { token: string }>("SELECT token FROM device_push_tokens WHERE user_id = ?").all(user.id);
    expect(remaining.map((r) => r.token)).toEqual(["valid-device"]);
  });

  it("baska bir kullanicinin cihazina gondermez", async () => {
    const other = createTestUser(user.station_id, "operator");
    registerDeviceToken(other.id, "other-device", "android");
    sendFcmMessageMock.mockResolvedValue({ success: true });

    await sendPushToUser(user.id, "Baslik", "Govde");

    expect(sendFcmMessageMock).not.toHaveBeenCalled();
  });
});

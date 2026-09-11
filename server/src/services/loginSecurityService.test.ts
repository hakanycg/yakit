import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import type { StationRow, UserRow } from "../db/types.js";
import { processWriteQueue } from "./writeQueueService.js";

const sendEmailMock = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true }));
vi.mock("./notificationService.js", () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
}));

const { recordLoginAndNotifyIfNewIp } = await import("./loginSecurityService.js");

let station: StationRow;
let user: UserRow;

beforeEach(() => {
  station = createTestStation();
  user = createTestUser(station.id, "admin");
  db.prepare("UPDATE users SET email = 'test@ornek.com', notify_email = 1 WHERE id = ?").run(user.id);
  user = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(user.id)!;
  sendEmailMock.mockClear();
  db.prepare("DELETE FROM write_queue").run();
  db.prepare("DELETE FROM known_login_ips WHERE user_id = ?").run(user.id);
});

async function drain() {
  await processWriteQueue();
}

describe("recordLoginAndNotifyIfNewIp", () => {
  it("ilk giriste (hic bilinen IP yokken) bildirim GONDERMEZ - her IP zaten yenidir", async () => {
    recordLoginAndNotifyIfNewIp(user, "203.0.113.10", "TestAgent/1.0");
    await drain();
    expect(sendEmailMock).not.toHaveBeenCalled();

    const row = db.prepare("SELECT * FROM known_login_ips WHERE user_id = ? AND ip_address = ?").get(user.id, "203.0.113.10");
    expect(row).toBeTruthy();
  });

  it("bilinen bir IP'den TEKRAR giriste bildirim gondermez", async () => {
    recordLoginAndNotifyIfNewIp(user, "203.0.113.10", "TestAgent/1.0");
    await drain();
    sendEmailMock.mockClear();

    recordLoginAndNotifyIfNewIp(user, "203.0.113.10", "TestAgent/1.0");
    await drain();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("daha once GORULMEMIS yeni bir IP'den giriste e-posta gonderir", async () => {
    recordLoginAndNotifyIfNewIp(user, "203.0.113.10", "TestAgent/1.0");
    await drain();
    sendEmailMock.mockClear();

    recordLoginAndNotifyIfNewIp(user, "198.51.100.20", "OtherAgent/2.0");
    await drain();

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0]![0]).toBe("test@ornek.com");
  });

  it("notify_email kapaliysa e-posta gondermez (yine de IP kaydedilir)", async () => {
    db.prepare("UPDATE users SET notify_email = 0 WHERE id = ?").run(user.id);
    recordLoginAndNotifyIfNewIp(user, "203.0.113.10", "TestAgent/1.0");
    await drain();
    sendEmailMock.mockClear();

    recordLoginAndNotifyIfNewIp(user, "198.51.100.20", "OtherAgent/2.0");
    await drain();

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("IP bilinmiyorsa (undefined) hicbir sey yapmaz", async () => {
    recordLoginAndNotifyIfNewIp(user, undefined, "TestAgent/1.0");
    await drain();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) as c FROM known_login_ips WHERE user_id = ?").get(user.id)).toEqual({ c: 0 });
  });

  it("kuyruk bosaltilmadan e-posta gonderilmez - kayit senkron/hizlidir", () => {
    recordLoginAndNotifyIfNewIp(user, "203.0.113.10", "TestAgent/1.0");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

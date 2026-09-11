import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import type { StationRow, UserRow } from "../db/types.js";
import { processWriteQueue } from "./writeQueueService.js";

const sendPushToUserMock = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("./pushNotificationService.js", () => ({
  sendPushToUser: (...args: unknown[]) => sendPushToUserMock(...args),
}));

const {
  ReleaseNoteError,
  createReleaseNote,
  deleteReleaseNote,
  getUnseenReleaseNotes,
  listReleaseNotes,
  markReleaseNotesSeen,
} = await import("./releaseNoteService.js");

let station: StationRow;
let admin: UserRow;

beforeEach(() => {
  station = createTestStation();
  admin = createTestUser(station.id, "super_admin");
  sendPushToUserMock.mockClear();
  // write_queue GLOBAL bir tablo (bkz. alarmService.test.ts'teki ayni yorum) - bu
  // testlerin yalnizca KENDI ekledigi kuyruk kayitlarini gormesi icin temizlenir.
  db.prepare("DELETE FROM write_queue").run();
});

/** createReleaseNote() push'u ANINDA gondermez, dayanikli kuyruga yazar - gercekten
 * gonderilmesi icin kuyrugun bosaltilmasi (processWriteQueue) gerekir. */
async function createAndDrain(input: { title: string; body: string; version?: string }) {
  const note = createReleaseNote(input, admin);
  await processWriteQueue();
  return note;
}

describe("createReleaseNote", () => {
  it("baslik/metin bos veya sadece boslukdan olusamaz", () => {
    expect(() => createReleaseNote({ title: "  ", body: "Merhaba" }, admin)).toThrow(ReleaseNoteError);
    expect(() => createReleaseNote({ title: "Baslik", body: "   " }, admin)).toThrow(ReleaseNoteError);
  });

  it("gecerli girdiyle kaydeder", () => {
    const note = createReleaseNote({ title: "Yeni ozellik", body: "Aciklama" }, admin);
    expect(note.title).toBe("Yeni ozellik");
    expect(note.body).toBe("Aciklama");
    expect(note.created_by).toBe(admin.id);
  });

  it("versiyon opsiyoneldir - verilmezse null, verilirse trim'lenmis haliyle kaydedilir", () => {
    const withoutVersion = createReleaseNote({ title: "Baslik", body: "Metin" }, admin);
    expect(withoutVersion.version).toBeNull();

    const withVersion = createReleaseNote({ title: "Baslik", body: "Metin", version: "  1.4.2  " }, admin);
    expect(withVersion.version).toBe("1.4.2");
  });
});

describe("createReleaseNote - mobil push", () => {
  it("notify_push acik AKTIF tum kullanicilara push gonderir (kuyruk bosaltilinca)", async () => {
    const withPush = createTestUser(station.id, "operator");
    db.prepare("UPDATE users SET notify_push = 1 WHERE id = ?").run(withPush.id);

    await createAndDrain({ title: "Yeni ozellik", body: "Aciklama" });

    expect(sendPushToUserMock).toHaveBeenCalledWith(withPush.id, "Yenilikler: Yeni ozellik", "Aciklama");
  });

  it("notify_push kapali kullaniciya gondermez", async () => {
    const withoutPush = createTestUser(station.id, "operator");
    db.prepare("UPDATE users SET notify_push = 0 WHERE id = ?").run(withoutPush.id);

    await createAndDrain({ title: "Duyuru", body: "..." });

    expect(sendPushToUserMock).not.toHaveBeenCalledWith(withoutPush.id, expect.anything(), expect.anything());
  });

  it("pasif (active=0) kullaniciya gondermez", async () => {
    const inactive = createTestUser(station.id, "operator");
    db.prepare("UPDATE users SET notify_push = 1, active = 0 WHERE id = ?").run(inactive.id);

    await createAndDrain({ title: "Duyuru", body: "..." });

    expect(sendPushToUserMock).not.toHaveBeenCalledWith(inactive.id, expect.anything(), expect.anything());
  });

  it("kuyruk bosaltilmadan gonderim yapilmaz - createReleaseNote senkron/hizlidir", () => {
    const withPush = createTestUser(station.id, "operator");
    db.prepare("UPDATE users SET notify_push = 1 WHERE id = ?").run(withPush.id);

    createReleaseNote({ title: "Duyuru", body: "..." }, admin);

    expect(sendPushToUserMock).not.toHaveBeenCalled();
  });
});

describe("listReleaseNotes", () => {
  // release_notes istasyon/kiraci bazli DEGIL, TUM platforma ait tek bir tablodur (bkz.
  // releaseNoteService.ts basindaki yorum) - bu yuzden diger testlerin eklediği kayitlarla
  // PAYLASILIR; yalnizca bu testin kendi eklediklerinin GORECELI sirasini dogrulariz.
  it("en yeniden en eskiye siralar", () => {
    createReleaseNote({ title: "Birinci", body: "A" }, admin);
    createReleaseNote({ title: "Ikinci", body: "B" }, admin);

    const notes = listReleaseNotes();
    expect(notes.slice(0, 2).map((n) => n.title)).toEqual(["Ikinci", "Birinci"]);
  });
});

describe("getUnseenReleaseNotes / markReleaseNotesSeen", () => {
  it("ilk kontrolde (hic gorulmemis) gecmisin tamami DEGIL, hicbir sey gostermez - o ana kadar yakalanmis sayilir", () => {
    createReleaseNote({ title: "Eski duyuru", body: "Bu kullanicidan ONCE var olan bir duyuru" }, admin);
    const newUser = createTestUser(station.id, "operator");

    const unseen = getUnseenReleaseNotes(newUser.id);
    expect(unseen).toHaveLength(0);
  });

  it("kullanici yakalandiktan SONRA eklenen duyurulari gorur", () => {
    createReleaseNote({ title: "Eski duyuru", body: "..." }, admin);
    const user = createTestUser(station.id, "operator");
    getUnseenReleaseNotes(user.id); // ilk kontrol - yakalanir

    const fresh = createReleaseNote({ title: "Yeni duyuru", body: "Bugun eklendi" }, admin);
    const unseen = getUnseenReleaseNotes(user.id);
    expect(unseen).toHaveLength(1);
    expect(unseen[0]!.id).toBe(fresh.id);
  });

  it("birden fazla kacirilan duyuru varsa hepsini eskiden yeniye doner", () => {
    const user = createTestUser(station.id, "operator");
    getUnseenReleaseNotes(user.id); // yakalanir (henuz duyuru yok)

    createReleaseNote({ title: "Birinci", body: "A" }, admin);
    createReleaseNote({ title: "Ikinci", body: "B" }, admin);

    const unseen = getUnseenReleaseNotes(user.id);
    expect(unseen.map((n) => n.title)).toEqual(["Birinci", "Ikinci"]);
  });

  it("markReleaseNotesSeen sonrasi ayni duyurular tekrar gorulmez", () => {
    const user = createTestUser(station.id, "operator");
    getUnseenReleaseNotes(user.id);
    createReleaseNote({ title: "Duyuru", body: "..." }, admin);

    expect(getUnseenReleaseNotes(user.id)).toHaveLength(1);
    markReleaseNotesSeen(user.id);
    expect(getUnseenReleaseNotes(user.id)).toHaveLength(0);
  });

  it("kullanicilar birbirinden bagimsizdir", () => {
    const userA = createTestUser(station.id, "operator");
    const userB = createTestUser(station.id, "operator");
    getUnseenReleaseNotes(userA.id);
    getUnseenReleaseNotes(userB.id);

    createReleaseNote({ title: "Duyuru", body: "..." }, admin);
    markReleaseNotesSeen(userA.id);

    expect(getUnseenReleaseNotes(userA.id)).toHaveLength(0);
    expect(getUnseenReleaseNotes(userB.id)).toHaveLength(1);
  });
});

describe("deleteReleaseNote", () => {
  it("var olan kaydi siler", () => {
    const note = createReleaseNote({ title: "Silinecek", body: "..." }, admin);
    deleteReleaseNote(note.id);
    expect(db.prepare("SELECT * FROM release_notes WHERE id = ?").get(note.id)).toBeUndefined();
  });

  it("olmayan kayit icin hata firlatir", () => {
    expect(() => deleteReleaseNote(999999)).toThrow(ReleaseNoteError);
  });
});

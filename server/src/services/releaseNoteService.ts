import { db } from "../db/index.js";
import type { ReleaseNoteRow, UserRow } from "../db/types.js";
import { sendPushToUser } from "./pushNotificationService.js";
import { enqueueWrite, registerWriteQueueHandler } from "./writeQueueService.js";

/**
 * "Yenilikler" duyurulari - super_admin, platforma bir guncelleme yayina alindiginda
 * ne degistigini yazar; TUM kullanicilar (istasyon/kiraci farki gozetmeksizin) gorur.
 *
 * Her kullanici icin "gorulmemis" durumu users.last_seen_release_note_id ile takip
 * edilir - ayri bir "okundu" tablosu yerine tek bir sayac yeterli, cunku duyurular
 * SIRALI (id artan) ve KULLANICI bunlari sirayla "yakaliyor": bir kullanicinin en son
 * gordugu id'den BUYUK olan her kayit onun icin yenidir.
 */

export class ReleaseNoteError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export interface CreateReleaseNoteInput {
  title: string;
  body: string;
  version?: string | null;
}

export function createReleaseNote(input: CreateReleaseNoteInput, actor: UserRow): ReleaseNoteRow {
  const title = input.title.trim();
  const body = input.body.trim();
  const version = input.version?.trim() || null;
  if (!title) throw new ReleaseNoteError("Baslik zorunludur.", 400);
  if (!body) throw new ReleaseNoteError("Metin zorunludur.", 400);

  const result = db
    .prepare("INSERT INTO release_notes (title, body, version, created_by) VALUES (?, ?, ?, ?)")
    .run(title, body, version, actor.id);
  const note = db.prepare<[number], ReleaseNoteRow>("SELECT * FROM release_notes WHERE id = ?").get(result.lastInsertRowid as number)!;

  // Uygulamayi hic acmadan da haberi olsun diye ayrica mobil push (bkz. asagidaki
  // write-queue handler'i) - istek BEKLEMEZ, kuyruk kaydi hemen (senkron) yazilir,
  // fiili gonderim arka planda olur (alarmService.ts'teki kritik alarm push'uyla AYNI
  // dayaniklilik ilkesi). "Yenilikler" TUM platforma ait oldugundan (bkz. dosya basi
  // yorumu) alici tek bir istasyona degil, notify_push acik TUM aktif kullanicilaradir.
  enqueueWrite("release_note_push", { title: note.title, body: note.body });

  return note;
}

registerWriteQueueHandler("release_note_push", async (payload) => {
  const { title, body } = payload as { title: string; body: string };
  const recipients = db.prepare<[], { id: number }>("SELECT id FROM users WHERE active = 1 AND notify_push = 1").all();
  await Promise.all(recipients.map((u) => sendPushToUser(u.id, `Yenilikler: ${title}`, body)));
});

export function listReleaseNotes(limit = 50): ReleaseNoteRow[] {
  return db.prepare<[number], ReleaseNoteRow>("SELECT * FROM release_notes ORDER BY id DESC LIMIT ?").all(limit);
}

function latestReleaseNoteId(): number | null {
  const row = db.prepare<[], { maxId: number | null }>("SELECT MAX(id) as maxId FROM release_notes").get();
  return row?.maxId ?? null;
}

/**
 * Bir kullanicinin henuz gormedigi duyurular - eskiden yeniye siralanir (kullanici
 * neyi kacirdigini kronolojik sirayla okusun diye).
 *
 * Ilk kez kontrol eden (last_seen_release_note_id = NULL) bir kullanici icin GECMISIN
 * TAMAMI gosterilmez - hesap ne zaman acilmis olursa olsun, o ana kadarki en son
 * duyuruya "yakalanmis" sayilir; yalnizca BUNDAN SONRAKI duyurular karsisina cikar.
 */
export function getUnseenReleaseNotes(userId: number): ReleaseNoteRow[] {
  const user = db.prepare<[number], { last_seen_release_note_id: number | null }>(
    "SELECT last_seen_release_note_id FROM users WHERE id = ?"
  ).get(userId);
  if (!user) return [];

  if (user.last_seen_release_note_id === null) {
    const latest = latestReleaseNoteId();
    db.prepare("UPDATE users SET last_seen_release_note_id = ? WHERE id = ?").run(latest ?? 0, userId);
    return [];
  }

  return db
    .prepare<[number], ReleaseNoteRow>("SELECT * FROM release_notes WHERE id > ? ORDER BY id ASC")
    .all(user.last_seen_release_note_id);
}

/** Kullanici duyuruyu gordu (popup'i kapatti ya da liste sayfasini acti) - su ana kadarki en son kayda yakalanir. */
export function markReleaseNotesSeen(userId: number): void {
  const latest = latestReleaseNoteId();
  if (latest === null) return;
  db.prepare("UPDATE users SET last_seen_release_note_id = ? WHERE id = ?").run(latest, userId);
}

export function deleteReleaseNote(id: number): void {
  const result = db.prepare("DELETE FROM release_notes WHERE id = ?").run(id);
  if (result.changes === 0) throw new ReleaseNoteError("Duyuru bulunamadi.", 404);
}

export function serializeReleaseNote(r: ReleaseNoteRow) {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    version: r.version,
    createdAt: r.created_at,
  };
}

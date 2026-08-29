import { db } from "../db/index.js";
import type { StaffAdvanceRow, UserRow } from "../db/types.js";

/**
 * Personel avans/masraf takibi (on muhasebe, 6. modul).
 *
 * users tablosunda ayri bir "personel" varligi yok - istasyon calisanlari
 * zaten users satirlari. kind='avans': calisana verilen, maastan kesilecek
 * nakit avans. kind='masraf': calisanin isletme icin kendi cebinden yaptigi,
 * geri odeme beklenen masraf. Ikisi de settled=0 iken "acik" bakiyeye girer.
 */

export class StaffAdvanceError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export const ADVANCE_KINDS = ["avans", "masraf"] as const;
export type AdvanceKind = (typeof ADVANCE_KINDS)[number];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function assertStationUser(stationId: number, userId: number): void {
  const row = db.prepare<[number, number], { id: number }>("SELECT id FROM users WHERE id = ? AND station_id = ?").get(userId, stationId);
  if (!row) throw new StaffAdvanceError("Personel bulunamadi.", 404);
}

export interface StaffAdvanceWithUser extends StaffAdvanceRow {
  display_name: string;
}

export function getEntry(stationId: number, id: number): StaffAdvanceWithUser {
  const row = db
    .prepare<[number, number], StaffAdvanceWithUser>(
      `SELECT sa.*, u.display_name FROM staff_advances sa JOIN users u ON u.id = sa.user_id WHERE sa.id = ? AND sa.station_id = ?`
    )
    .get(id, stationId);
  if (!row) throw new StaffAdvanceError("Kayit bulunamadi.", 404);
  return row;
}

export interface CreateEntryInput {
  userId: number;
  kind: AdvanceKind;
  amount: number;
  description?: string;
  entryDate: string;
}

export function createEntry(stationId: number, input: CreateEntryInput, actor: UserRow): StaffAdvanceWithUser {
  if (!(input.amount > 0)) throw new StaffAdvanceError("Tutar sifirdan buyuk olmalidir.");
  assertStationUser(stationId, input.userId);

  const result = db
    .prepare(
      "INSERT INTO staff_advances (station_id, user_id, kind, amount, description, entry_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(stationId, input.userId, input.kind, round2(input.amount), input.description?.trim() || null, input.entryDate, actor.id);
  return getEntry(stationId, result.lastInsertRowid as number);
}

export function settleEntry(stationId: number, id: number): StaffAdvanceWithUser {
  getEntry(stationId, id);
  db.prepare("UPDATE staff_advances SET settled = 1, settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND station_id = ?").run(
    id,
    stationId
  );
  return getEntry(stationId, id);
}

export function deleteEntry(stationId: number, id: number): void {
  getEntry(stationId, id);
  db.prepare("DELETE FROM staff_advances WHERE id = ? AND station_id = ?").run(id, stationId);
}

export interface StaffBalance {
  userId: number;
  displayName: string;
  openAvans: number;
  openMasraf: number;
}

export function getStaffBalances(stationId: number): StaffBalance[] {
  const rows = db
    .prepare<[number], { user_id: number; display_name: string; open_avans: number | null; open_masraf: number | null }>(
      `SELECT u.id as user_id, u.display_name,
              COALESCE(SUM(CASE WHEN sa.kind = 'avans' AND sa.settled = 0 THEN sa.amount ELSE 0 END), 0) as open_avans,
              COALESCE(SUM(CASE WHEN sa.kind = 'masraf' AND sa.settled = 0 THEN sa.amount ELSE 0 END), 0) as open_masraf
         FROM users u
         LEFT JOIN staff_advances sa ON sa.user_id = u.id AND sa.station_id = u.station_id
        WHERE u.station_id = ?
        GROUP BY u.id
       HAVING open_avans > 0 OR open_masraf > 0
        ORDER BY u.display_name`
    )
    .all(stationId);

  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    openAvans: round2(r.open_avans ?? 0),
    openMasraf: round2(r.open_masraf ?? 0),
  }));
}

export interface EntryListFilters {
  userId?: number;
  kind?: AdvanceKind;
  settled?: boolean;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedEntries {
  entries: StaffAdvanceWithUser[];
  total: number;
  page: number;
  pageSize: number;
}

export function listEntriesPaged(stationId: number, filters: EntryListFilters): PagedEntries {
  const clauses = ["sa.station_id = ?"];
  const params: (string | number)[] = [stationId];
  if (filters.userId) {
    clauses.push("sa.user_id = ?");
    params.push(filters.userId);
  }
  if (filters.kind) {
    clauses.push("sa.kind = ?");
    params.push(filters.kind);
  }
  if (filters.settled !== undefined) {
    clauses.push("sa.settled = ?");
    params.push(filters.settled ? 1 : 0);
  }
  if (filters.from) {
    clauses.push("sa.entry_date >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push("sa.entry_date <= ?");
    params.push(filters.to);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;

  const total = (
    db
      .prepare<(string | number)[], { count: number }>(`SELECT COUNT(*) AS count FROM staff_advances sa ${where}`)
      .get(...params) ?? { count: 0 }
  ).count;

  const pageSize = Math.min(Math.max(filters.pageSize ?? 25, 1), 200);
  const page = Math.max(filters.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  const entries = db
    .prepare<(string | number)[], StaffAdvanceWithUser>(
      `SELECT sa.*, u.display_name
         FROM staff_advances sa
         JOIN users u ON u.id = sa.user_id
         ${where}
        ORDER BY sa.entry_date DESC, sa.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset);

  return { entries, total, page, pageSize };
}

export function serializeEntry(e: StaffAdvanceWithUser) {
  return {
    id: e.id,
    userId: e.user_id,
    displayName: e.display_name,
    kind: e.kind,
    amount: e.amount,
    description: e.description,
    entryDate: e.entry_date,
    settled: !!e.settled,
    settledAt: e.settled_at,
    createdAt: e.created_at,
  };
}

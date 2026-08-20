import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

/** Test paketi calismadan once, onceki bir kosudan kalmis olabilecek test veritabanini temizler. */
export default function globalSetup(): void {
  const dbPath = resolve(process.cwd(), "./data/test.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) rmSync(p);
  }
}

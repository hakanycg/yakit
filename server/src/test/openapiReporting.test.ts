import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

/**
 * docs/openapi-reporting.yaml ELLE yazilmis bir referanstir (bkz. dosyanin kendi
 * ust bilgisi) - koddan uretilmez/dogrulanmaz. Bu test onun YERINE gecmez; yalnizca
 * dosyanin GECERLI YAML oldugunu ve belgeledigini iddia ettigi 6 ucu gercekten
 * icerdigini dogrular - route imzasiyla tutarliligini degil.
 */
const path = fileURLToPath(new URL("../../../docs/openapi-reporting.yaml", import.meta.url));

describe("docs/openapi-reporting.yaml", () => {
  it("gecerli YAML'dir", () => {
    const raw = readFileSync(path, "utf-8");
    expect(() => load(raw)).not.toThrow();
  });

  it("belgeledigini iddia ettigi 6 raporlama ucunu icerir", () => {
    const raw = readFileSync(path, "utf-8");
    const doc = load(raw) as { paths?: Record<string, unknown> };

    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(
      [
        "/api/reports/summary",
        "/api/reports/refunds",
        "/api/reports/accounting-export",
        "/api/portfolio",
        "/api/portfolio/export.csv",
        "/api/reconciliation/summary",
      ].sort()
    );
  });

  it("her ucun 200 yaniti tanimlidir", () => {
    const raw = readFileSync(path, "utf-8");
    const doc = load(raw) as { paths: Record<string, { get?: { responses?: Record<string, unknown> } }> };

    for (const [route, item] of Object.entries(doc.paths)) {
      expect(item.get?.responses?.["200"], `${route} icin 200 yaniti eksik`).toBeDefined();
    }
  });
});

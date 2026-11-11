// apps/server/src/__tests__/macroHistoryAlignment.test.ts
/**
 * Piece 7b, shippedAlignment.test.ts style: raw hashes, end months, the known gap, the rebase. Literals restated.
 * Monitoring trigger (Section 13): fails on an as-of move of the base market; re-pin only with a recorded hand check.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../config";
import { buildMacroDemoOps, cutAt, parseFredCsv } from "../../scripts/macroSeed";

const dir = join(repoRoot(), "apps", "server", "data", "macro");
const manifest = JSON.parse(readFileSync(join(dir, "macro_source_manifest.json"), "utf8")) as {
  series: Array<{ seriesId: string; file: string; sha256: string; endMonth: string; knownGaps: string[] }>;
};
const market = JSON.parse(readFileSync(join(repoRoot(), "packages", "kernel", "public", "market_public.json"), "utf8")) as { calibration_date: string };

describe("shipped macro histories", () => {
  it("each raw file hashes to its manifest row", () => {
    for (const row of manifest.series) {
      expect(createHash("sha256").update(readFileSync(join(dir, row.file))).digest("hex")).toBe(row.sha256);
    }
  });
  it("each history ends at the base market's calibration month", () => {
    for (const row of manifest.series) expect(row.endMonth).toBe(market.calibration_date.slice(0, 7));
    expect(market.calibration_date.slice(0, 7)).toBe("2026-03");
  });
  it("the knownGaps listed are exactly the empty months of the raw file up to the end month", () => {
    for (const row of manifest.series) {
      const rows = cutAt(parseFredCsv(readFileSync(join(dir, row.file), "utf8"), row.seriesId), row.endMonth);
      expect(rows.filter((r) => r.value === null).map((r) => r.month)).toEqual(row.knownGaps);
    }
    expect(manifest.series.find((r) => r.seriesId === "UNRATE")!.knownGaps).toEqual(["2025-10"]);
  });
  it("the seeded ops cut at 2026-03, rebase FHFA to 1 there and store UNRATE as a decimal", () => {
    const ops = buildMacroDemoOps(repoRoot());
    const hpi = ops.find((o) => o.id === "hpi-fhfa-po")!;
    const un = ops.find((o) => o.id === "unrate")!;
    expect([hpi.firstMonth, hpi.values.length, hpi.values[hpi.values.length - 1]]).toEqual(["1991-01", 423, 1]);
    expect(hpi.values[0]).toBe(Number((100 / 441.51).toPrecision(12)));
    expect([un.firstMonth, un.values.length, un.values[un.values.length - 1]]).toEqual(["1948-01", 939, 0.043]);
    expect(un.values[933]).toBeNull(); // 2025-10 is 1948-01 plus 933 months
    expect(ops.map((o) => o.id)).toEqual(["hpi-fhfa-po", "unrate", "hpi-flat", "hpi-down-30", "hpi-up-15"]);
  });
});

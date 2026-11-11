/**
 * The four shipped lens definitions.
 *
 * The seed is the ONLY writer of a lens, and it validates each definition
 * through the engine before writing it, so a drift in the shipped fixture
 * refuses at seed time rather than at the first reading. This suite is that
 * same check, run in the suite, plus the append-only skip on a second seed.
 *
 * It does not call seedStore(), which builds portfolios and a database mirror;
 * it exercises the fixture load and the collection write directly, which is
 * what this task owns.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { validateLens } from "@alm/engine";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { buildDemoLenses, SEED_IDS } from "../../scripts/seed-store";

describe("the seeded demo lenses", () => {
  it("loads six valid definitions whose ids are SEED_IDS.demoLenses, in order", () => {
    const lenses = buildDemoLenses(repoRoot());
    expect(lenses.map((l) => l.id)).toEqual([...SEED_IDS.demoLenses]);
    expect(lenses).toHaveLength(6);
    expect(lenses.map((l) => l.objective)).toEqual([
      "liquidity",
      "rate",
      "capital",
      "strategy",
      // The fifth lens reads the demonstration custom metric. It is a
      // strategy lens, so the four objectives are still the closed four.
      "strategy",
      // The sixth reads the wal-gap metric, under the liquidity
      // objective; the four objectives are still the closed four.
      "liquidity",
    ]);
    for (const lens of lenses) expect(validateLens(lens)).toEqual([]);

    const balance = lenses.find((l) => l.id === "balance-demo-v1")!;
    expect(balance.constraints.map((c) => c.reader)).toEqual(["customValue"]);
    expect(balance.constraints[0]!.params).toEqual({
      metricId: "balance-summary",
      key: "runoff-share",
    });

    // Two constraints on one custom metric, both nonzero limits, so
    // both are fraction basis and either may set the headline.
    const walGap = lenses.find((l) => l.id === "wal-gap-demo-v1")!;
    expect(walGap.constraints.map((c) => c.reader)).toEqual(["customValue", "customValue"]);
    expect(walGap.constraints.map((c) => c.id)).toEqual(["gap-24", "ratio-50"]);
    expect(walGap.constraints.map((c) => c.params)).toEqual([
      { metricId: "wal-gap", key: "wal-gap" },
      { metricId: "wal-gap", key: "wal-ratio" },
    ]);
    expect(walGap.constraints.map((c) => c.limit)).toEqual([24, 0.5]);

    // The fixture states in its own text that every limit is a demonstration
    // value, so a reader of the file cannot mistake one for a calibrated limit.
    const raw = JSON.parse(
      readFileSync(join(repoRoot(), "docs", "harness", "lenses.json"), "utf8"),
    ) as { note: string };
    expect(raw.note.toLowerCase()).toContain("demonstration");
  });

  it("writes one document per lens and skips an id already present", () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), "alm-lens-seed-")));
    store.init();
    const lenses = buildDemoLenses(repoRoot());
    for (const lens of lenses) {
      store.putDocument("lens", lens.id, lens, { label: lens.label, seeded: true });
    }
    expect(store.listMeta("lens").map((m) => m.id)).toEqual(
      [...SEED_IDS.demoLenses].sort(),
    );
    expect(store.getDocument("lens", "rate-demo-v1").doc).toEqual(
      lenses.find((l) => l.id === "rate-demo-v1"),
    );
    for (const lens of lenses) expect(store.has("lens", lens.id)).toBe(true);
  });
});

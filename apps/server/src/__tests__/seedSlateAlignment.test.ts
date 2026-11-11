/**
 * W5-D2 — the seeded scenario slates share ONE scenario-id convention.
 *
 * The defect (W4-U1 Sections 4/5): the seeded vanilla slate carried the
 * builder's SM100/SM200 down-shock ids while the demo and stress slates use
 * S{shockBp} (S-100/S-200). The Compare view joins rows by scenario id — a
 * label does not prove two scenarios identical — so a cross-slate compare of
 * the same down-shock rendered as two duplicate-labeled, un-joined rows. The
 * cure remaps the vanilla ids at the SEED BOUNDARY only (seed-store.ts
 * alignVanillaScenarioIds): the @alm/data builder and the acceptance
 * battery's direct use of it (which pins SM200/SM100) are untouched.
 *
 * Anchors:
 *   - all three seeded slates carry the identical scenario-id SET
 *     {S-200, S-100, S0, S100, S200}, each id exactly once;
 *   - across the three slates, equal labels imply equal ids (the exact
 *     collision W4-U1 disclosed is impossible);
 *   - the remap moved ONLY ids: the aligned vanilla slate's labels, rate
 *     specs, and assumption binding equal the builder's output element for
 *     element;
 *   - the seed remains idempotent: a second seedStore() over the same store
 *     skips every slate (append-only, nothing rewritten).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scenario } from "@alm/engine";
import { vanillaScenarios } from "@alm/data";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { seedStore, SEED_IDS, alignVanillaScenarioIds } from "../../scripts/seed-store";

interface SlateDoc {
  id: string;
  label: string;
  scenarios: Scenario[];
}

const SLATE_IDS = [SEED_IDS.demoSlate, SEED_IDS.vanillaSlate, SEED_IDS.stressSlate] as const;
const ALIGNED_ID_SET = ["S-200", "S-100", "S0", "S100", "S200"];

let storeRoot: string;
let store: FileStore;

beforeAll(async () => {
  storeRoot = mkdtempSync(join(tmpdir(), "alm-seed-slate-ids-"));
  store = new FileStore(storeRoot);
  await seedStore(store, repoRoot());
}, 120_000);

afterAll(() => {
  try {
    rmSync(storeRoot, { recursive: true, force: true });
  } catch {
    // Windows file locking (McAfee); the OS temp cleaner owns the leftovers.
  }
});

describe("seeded slate scenario-id convention", () => {
  it("all three seeded slates carry the identical scenario-id set, each id once", () => {
    for (const slateId of SLATE_IDS) {
      const slate = store.getDocument<SlateDoc>("scenario-slates", slateId).doc;
      const ids = slate.scenarios.map((s) => s.id);
      expect(new Set(ids).size, slateId).toBe(ids.length);
      expect([...ids].sort(), slateId).toEqual([...ALIGNED_ID_SET].sort());
    }
  });

  it("across the seeded slates, equal labels imply equal ids (no duplicate-labeled un-joined rows)", () => {
    const idByLabel = new Map<string, string>();
    for (const slateId of SLATE_IDS) {
      const slate = store.getDocument<SlateDoc>("scenario-slates", slateId).doc;
      for (const s of slate.scenarios) {
        const seen = idByLabel.get(s.label);
        if (seen === undefined) {
          idByLabel.set(s.label, s.id);
        } else {
          expect(seen, `label "${s.label}" in ${slateId}`).toBe(s.id);
        }
      }
    }
  });

  it("the remap moved only ids: labels, rate specs, and binding equal the builder's output", () => {
    const raw = vanillaScenarios(SEED_IDS.vanillaAssumptions);
    const seeded = store.getDocument<SlateDoc>("scenario-slates", SEED_IDS.vanillaSlate).doc;
    expect(seeded.scenarios.length).toBe(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const { id: rawId, ...rawRest } = raw[i];
      const { id: seededId, ...seededRest } = seeded.scenarios[i];
      expect(seededRest, rawId).toEqual(rawRest);
      // The id is the remapped form of the builder's id and nothing else.
      const expected = rawId === "SM100" ? "S-100" : rawId === "SM200" ? "S-200" : rawId;
      expect(seededId).toBe(expected);
    }
    // The exported helper agrees with what the seed stored.
    expect(alignVanillaScenarioIds(raw).map((s) => s.id)).toEqual(
      seeded.scenarios.map((s) => s.id),
    );
  });

  it("re-seeding the same store skips every slate (append-only preserved)", async () => {
    const second = await seedStore(store, repoRoot());
    expect(second.written).toEqual([]);
    for (const slateId of SLATE_IDS) {
      expect(second.skipped).toContain(`scenario-slates/${slateId}`);
    }
  });
});

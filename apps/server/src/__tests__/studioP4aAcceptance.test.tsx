// apps/server/src/__tests__/studioP4aAcceptance.test.tsx
/**
 * ALM Studio Piece 4a acceptance on a freshly seeded test platform. The Studio set editor's model
 * opens the seeded demo set, edits one decay bucket share and saves through
 * the real server and store; the stored copy carries the new share under a
 * new id with every modelVersion unchanged, and the by-kind page links to it.
 * A NaN posted around the form, and a share the schema bounds, are refused by
 * the server with the field's label and path, and nothing is stored. Expected
 * values and texts are restated here.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet } from "@alm/engine";
import { ApiError, createAssumptionSet, getAssumptionSet, listAssumptionSets } from "@alm/reader";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { bootTestPlatform, type TestPlatform } from "./harness";
import { changesOf, draftSet, issuesOf, saveBlock, saveEdited, savePayload, setCell, setValue } from "../../../studio/src/assumptions/setEditModel";
import { byKindModel } from "../../../studio/src/assumptions/byKindModel";
import { ByKindView } from "../../../studio/src/pages/assumptions/ByKindPage";
import { pageErrText } from "../../../studio/src/errText";

let t: TestPlatform;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
  // Studio's reader client calls relative /api paths; send them to the test platform.
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    realFetch(typeof input === "string" && input.startsWith("/") ? `${t.base}${input}` : input, init));
});
afterAll(() => {
  vi.unstubAllGlobals();
  return t.close();
});

const SOURCE = "demo-behavioral-v1";
/** The seeded demo set's dda decay binding sits third (data/src/demo/request.ts buildDemoAssumptions). */
const DECAY = 2;

describe("ALM Studio P4a acceptance", () => {
  it("saves an edited decay bucket share under a new id; modelVersion unchanged; the by-kind page links to the copy", async () => {
    const source = await getAssumptionSet(SOURCE);
    expect([source.bindings[DECAY]!.familyId, source.bindings[DECAY]!.overlay.kind]).toEqual(["dda", "nmd-decay"]);
    const draft = setCell(draftSet(source), DECAY, "params.buckets", 1, "share", "0.3");
    expect(changesOf(draft)).toEqual([{ where: "dda, whole family", label: "Share, row 2", from: "0.25", to: "0.3" }]);
    expect(saveBlock(draft, false, null)).toBeNull();

    const taken = new Set((await listAssumptionSets()).map((s) => s.id));
    const r = await saveEdited(draft, taken);
    if (r.kind !== "saved") throw new Error(r.text);
    expect(r.set.id).toBe("demo-behavioral-v1-edit-1");

    const stored = await getAssumptionSet("demo-behavioral-v1-edit-1");
    expect(stored.label).toBe("Demo base behavioral set");
    expect(stored.bindings.map((b) => b.modelVersion)).toEqual(["kernel-four-factor-cpr-1", "kernel-four-factor-cpr-1", "kernel-nmd-decay-1", "kernel-deposit-beta-1"]);
    const shares = (stored.bindings[DECAY]!.overlay as unknown as { params: { buckets: Array<{ share: number }> } }).params.buckets.map((b) => b.share);
    expect(shares).toEqual([0.45, 0.3, 0.2, 0.1]);
    // Only the edited binding moved; the engine's hash records the change.
    expect(stored.bindings.filter((_, k) => k !== DECAY)).toEqual(source.bindings.filter((_, k) => k !== DECAY));
    expect(stored.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.contentHash).not.toBe(source.contentHash);

    const sets = await Promise.all((await listAssumptionSets()).map((s) => getAssumptionSet(s.id)));
    const html = renderToStaticMarkup(<ByKindView ws="ws-a" kinds={["nmd-decay"]} model={byKindModel(sets, ["nmd-decay"])} query={{ book: "synthetic-2500-v1" }} />);
    expect(html).toContain('<a href="#/ws/ws-a/assumptions/sets?set=demo-behavioral-v1-edit-1" aria-label="Edit demo-behavioral-v1-edit-1">Edit</a>');
  });

  it("refuses a NaN and a share above 1 at the server with the field's label and path, and stores nothing", async () => {
    const source = await getAssumptionSet(SOURCE);
    const before = (await listAssumptionSets()).map((s) => s.id).sort();

    // The form holds Save off on text that is not a number.
    const typed = setValue(draftSet(source), DECAY, "params.sens.bStar", "abc");
    expect(issuesOf(typed.bindings[DECAY]!)).toEqual([{ path: "params.sens.bStar", label: "Sensitivity midpoint balance", message: "Enter a number" }]);
    expect(saveBlock(typed, false, null)).toBe("Off: one field needs a fix");

    // A NaN posted around the form: JSON carries it as null, and the engine refuses it at save.
    const nan: AssumptionSet = savePayload(draftSet(source), "demo-behavioral-v1-nan");
    (nan.bindings[DECAY]!.overlay as unknown as { params: { sens: { bStar: number } } }).params.sens.bStar = Number.NaN;
    let refused: unknown;
    try { await createAssumptionSet(nan); } catch (e) { refused = e; }
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(422);
    expect(pageErrText(refused)).toBe("422: invalid assumption set at bindings[2].overlay.params.sens.bStar: Sensitivity midpoint balance must be a number");

    // A share the schema bounds, through the editor's own save path: the server's text, verbatim.
    const high = setCell(draftSet(source), DECAY, "params.buckets", 1, "share", "1.5");
    expect(issuesOf(high.bindings[DECAY]!)).toEqual([{ path: "params.buckets[1].share", label: "Share, row 2", message: "must be at most 1" }]);
    expect(await saveEdited(high, new Set(before))).toEqual({
      kind: "refused",
      text: "422: invalid assumption set at bindings[2].overlay.params.buckets[1].share: Share, row 2 must be at most 1",
    });

    expect((await listAssumptionSets()).map((s) => s.id).sort()).toEqual(before);
  });
});

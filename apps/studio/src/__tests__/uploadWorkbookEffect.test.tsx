/**
 * Studio visible-fix F4: the effect that clears a false import note once another snapshot is attached. Studio tests have
 * no DOM and a server render never runs effects, so React's `useEffect` is captured here, and every state setter is
 * recorded, so the effect's dependencies and its body can be read and run by hand. Kept in its own file because the mock
 * replaces `react` for every module this file loads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceManifest } from "@alm/reader";
import { UploadWorkbook, type UploadOutcome } from "../pages/market/UploadWorkbook";
import { HEAD } from "./fixtures/workspace";

const seen = vi.hoisted(() => ({
  effects: [] as Array<{ run: () => unknown; deps: unknown[] | undefined }>,
  updates: [] as unknown[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (run: () => unknown, deps?: unknown[]) => { seen.effects.push({ run, deps }); },
    useState: (init: unknown) => {
      const [value, set] = actual.useState(init);
      return [value, (u: unknown) => { seen.updates.push(u); set(u as never); }];
    },
  };
});

beforeEach(() => { seen.effects.length = 0; seen.updates.length = 0; });

const BLANK: WorkspaceManifest = { ...HEAD, id: "ws-blank", blocks: { ...HEAD.blocks, market: { ...HEAD.blocks.market, snapshot: null, derived: [] } } };
const ok = (id: string): UploadOutcome => ({ kind: "ok", id, calibrationDate: null, note: `Imported ${id} and attached it.` });

/** Renders the card once and returns its one effect: what it is keyed on, and the state update its body makes. */
function effectOf(head: WorkspaceManifest) {
  renderToStaticMarkup(<UploadWorkbook head={head} onChanged={() => {}} />);
  expect(seen.effects).toHaveLength(1);
  const [effect] = seen.effects;
  effect.run();
  expect(seen.updates).toHaveLength(1);
  const update = seen.updates[0];
  expect(typeof update).toBe("function");
  return { deps: effect.deps, apply: update as (o: UploadOutcome | null) => UploadOutcome | null };
}

describe("the card's attach effect", () => {
  it("is keyed on the attached snapshot id of the head, and on null when none is attached", () => {
    const attachedId = HEAD.blocks.market.snapshot!.id;
    expect(effectOf(HEAD).deps).toEqual([attachedId]);
    seen.effects.length = 0; seen.updates.length = 0;
    expect(effectOf(BLANK).deps).toEqual([null]);
  });
  it("its body drops a note that names another snapshot and keeps the one for the snapshot now attached", () => {
    const attachedId = HEAD.blocks.market.snapshot!.id;
    const { apply } = effectOf(HEAD);
    expect(apply(ok("market_other"))).toBeNull();
    const own = ok(attachedId);
    expect(apply(own)).toBe(own);
    expect(apply(null)).toBeNull();
  });
});

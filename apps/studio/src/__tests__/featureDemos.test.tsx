/**
 * The feature demo cards (shown since S3f behind Start here's "More about this demo") and the call a
 * demo's Open makes. The section that rendered them on Home was removed in the S3f cleanup; its render cases moved to
 * apps/studio/src/__tests__/s3fStartHere.test.tsx.
 */
import { describe, expect, it } from "vitest";
import type { ExampleDemoRow, RunSetup, WorkspaceManifest } from "@alm/reader";
import { DEMO_CARDS, demoWorkspace, openFeatureDemo, wordCount, type DemoApi } from "../guided/featureDemos";

const IDS = ["seg", "regulatory", "spread-consistent", "six-shocks", "instruments", "constant-prepay", "fixed-ladder"];

function ws(id: string, over: Partial<WorkspaceManifest> & { book?: string } = {}): WorkspaceManifest {
  const { book, ...rest } = over;
  return {
    id,
    name: id,
    status: "active",
    lock: null,
    createdAt: "2026-11-04T00:00:00.000Z",
    revision: 3,
    blocks: { positions: { book: book === undefined ? null : { collection: "portfolios", id: book } }, assumptions: { sets: [{ collection: "assumption-sets", id: "guided-x-1" }] } },
    ...rest,
  } as unknown as WorkspaceManifest;
}

const row = (id: string, setIds = ["quillfield-illustrative-v1"]): ExampleDemoRow => ({ id, title: id, lineageId: `demo-${id}`, setupId: `rs-${id}`, setIds, stored: true });

describe("the feature demo cards", () => {
  it("are seven, in the server's order", () => {
    expect(DEMO_CARDS.map((c) => c.id)).toEqual(IDS);
  });

  it("each is one plain paragraph of about 60 to 90 words that names a place to look and a change", () => {
    for (const c of DEMO_CARDS) {
      const n = wordCount(c.text);
      expect(n, `${c.id}: ${n} words`).toBeGreaterThanOrEqual(60);
      expect(n, `${c.id}: ${n} words`).toBeLessThanOrEqual(90);
      expect(c.text, c.id).toContain("Launch it, then open Results");
      expect(c.text, c.id).toContain("Change ");
      // No long dash, no short dash between words, no section sign (built from code points, so this file holds none).
      const banned = [0x2014, 0x2013, 0xa7].map((n) => String.fromCharCode(n));
      expect(banned.some((ch) => (c.text + c.title + c.look + c.notes.join(" ")).includes(ch)), c.id).toBe(false);
    }
  });

  it("the SEG card says what the block leaves out and which base its NIM is on (fix round M4, Q4)", () => {
    const c = DEMO_CARDS.find((x) => x.id === "seg")!;
    expect(c.text).toContain("It covers every earning asset and every liability but the CDs. The CDs and the swap are outside it");
    expect(c.notes.join(" ")).toContain("over total assets");
    expect(c.notes.join(" ")).toContain("3.84 percent, is on earning assets");
  });

  it("the regulatory card names the standard as a reference, the non-core share and the floating slice (fix round M3, Q3)", () => {
    const c = DEMO_CARDS.find((x) => x.id === "regulatory")!;
    expect(c.text).toContain("international (Basel) standard, shown as a reference. The US has not adopted it.");
    expect(c.text).toContain("about 31 percent of the deposits, from 10 to 50 percent by deposit");
    expect(c.text).not.toMatch(/supervisors prescribe|frozen|small slice/);
    const notes = c.notes.join(" ");
    expect(notes).toContain("The interest-bearing non-core slice floats");
    expect(notes).toContain("retail transactional, retail non-transactional and wholesale");
  });

  it("the Details carry the known gaps where a reader looks (fix round L5, L6, L8, Q1)", () => {
    const notes = (id: string) => DEMO_CARDS.find((x) => x.id === id)!.notes.join(" ");
    expect(notes("instruments")).toContain("are valued at par in every scenario, as Value (EVE) values them");
    expect(notes("constant-prepay")).toContain("leaves out the certificates of deposit");
    expect(notes("constant-prepay")).toContain("No borrowing matures within the ladder's 12 months");
    expect(notes("spread-consistent")).toContain("A store that imported version 1.0 keeps it");
    expect(notes("six-shocks")).toContain("recalibrated in July 2024");
  });

  it("the spread-consistent card says in one plain line how it differs from all-in", () => {
    const c = DEMO_CARDS.find((x) => x.id === "spread-consistent")!;
    expect(c.text).toContain("All-in uses the funding curve alone, so the only difference is that loans are worth less here.");
  });
});

describe("which workspace a demo opens on", () => {
  it("is the newest active, unlocked workspace on the example bank's book; none otherwise", () => {
    const list = [
      ws("ws-a", { book: "mid-size-bank-v1", createdAt: "2026-11-01T00:00:00.000Z" }),
      ws("ws-b", { book: "mid-size-bank-v1", createdAt: "2026-11-03T00:00:00.000Z" }),
      ws("ws-c", { book: "mid-size-bank-v1", createdAt: "2026-11-04T00:00:00.000Z", status: "archived" }),
      ws("ws-d", { book: "example-book-v1", createdAt: "2026-11-05T00:00:00.000Z" }),
    ];
    expect(demoWorkspace(list, "mid-size-bank-v1")?.id).toBe("ws-b");
    expect(demoWorkspace([ws("ws-e")], "mid-size-bank-v1")).toBeNull();
  });
});

describe("Open", () => {
  it("adds only the sets the workspace lacks, saves the stored setup without its id into the demo's slot, and lands on Run setups", async () => {
    const calls: string[] = [];
    let revision = 3;
    const stored = { id: "rs-constant-prepay", name: "Demo", schemaVersion: "1.0.0" } as unknown as RunSetup;
    const api: DemoApi = {
      getWorkspace: async () => ws("ws-x", { book: "mid-size-bank-v1" }),
      setBlock: async (_id, body) => { calls.push(`set ${body.op} ${body.ref?.id} at ${body.expectedRevision}`); revision += 1; return ws("ws-x", { revision }); },
      getRunSetup: async (id) => { calls.push(`get ${id}`); return stored; },
      saveRunSetup: async (body) => { calls.push(`save ${body.setupLineageId} at ${body.expectedRevision} ${JSON.stringify(body.setup)}`); return {} as never; },
    };
    const href = await openFeatureDemo({ ws: "ws-x", demo: row("constant-prepay", ["guided-x-1", "quillfield-constant-prepay-v1"]), by: "Learner" }, api);
    expect(calls).toEqual([
      "set add quillfield-constant-prepay-v1 at 3",
      "get rs-constant-prepay",
      'save demo-constant-prepay at 4 {"name":"Demo","schemaVersion":"1.0.0"}',
    ]);
    expect(href).toBe("#/ws/ws-x/run/setups/demo-constant-prepay");
  });
});

/**
 * Controls 2 (approvals): the append-only approvals store over HTTP.
 *
 *   GET  /api/approvals                          every record, ascending id
 *   GET  /api/approvals/status/:collection/:id   the state of one artifact
 *   GET  /api/approvals/:id                      one record, verbatim
 *   POST /api/approvals                          201 with the stored record
 *
 * Artifacts are written straight through the store (an assumption set through
 * the real bind route, so its bindings hash differs from its file hash). A run
 * is a hand-written status.json plus result.json, which is all the route reads.
 * Expected ids, codes and hashes are restated here, not imported.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AssumptionSet } from "@alm/engine";
import { BETA_S_CURVE_DEFAULTS } from "@alm/kernel";
import { openPlatformDb, defaultDbPath } from "../db/database";
import { syncStoreToDb } from "../db/ingest";
import { LINEAGE_COLLECTIONS } from "../db/queries";
import { FileStore, serializeDocument } from "../store/store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

let tp: TestPlatform;
let store: FileStore;

const sha = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface Rec {
  id: string;
  artifactCollection: string;
  artifactId: string;
  artifactContentHash: string;
  decision: string;
  by: string;
  at: string;
  note: string;
}
interface Status {
  artifactCollection: string;
  artifactId: string;
  currentContentHash: string;
  state: string;
  latest: Rec | null;
  records: Rec[];
}
interface Err {
  error: { code: string; message: string };
}

/** The record directory, name to bytes. */
function approvalFiles(): Record<string, string> {
  const dir = store.paths.collectionDir("approvals");
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).sort()) out[f] = readFileSync(join(dir, f), "utf8");
  return out;
}

function putRun(runId: string, state: string, result?: string): void {
  store.writeRunJson(runId, "status.json", {
    runId,
    state,
    submittedAt: "2026-10-02T09:00:00.000Z",
    platformRequestHash: "0".repeat(64),
    summary: { portfolioId: "p", marketId: "m", scenarioSlateId: "s", scenarioCount: 1 },
  });
  if (result !== undefined) writeFileSync(store.paths.runFile(runId, "result.json"), result);
}

const body = (over: Record<string, unknown>): Record<string, unknown> => ({
  artifactCollection: "run-plans",
  artifactId: "plan-x",
  artifactContentHash: "0".repeat(64),
  decision: "approved",
  by: "A. Reviewer",
  ...over,
});

async function status(coll: string, id: string): Promise<Status> {
  const r = await api<Status>(tp.base, "GET", `/api/approvals/status/${coll}/${id}`);
  expect(r.status).toBe(200);
  return r.body;
}

let setId = "";
let setFileHash = "";
let setBindingsHash = "";

beforeAll(async () => {
  tp = await bootTestPlatform();
  store = tp.platform.context.store;
  const base: AssumptionSet = {
    schemaVersion: "1.0.0",
    id: "set-appr",
    label: "approval fixture set",
    bindings: [
      { familyId: "mma", overlay: { kind: "deposit-beta", params: BETA_S_CURVE_DEFAULTS }, modelVersion: "kernel-deposit-beta-1" },
    ],
  };
  const created = await api(tp.base, "POST", "/api/assumption-sets", base);
  expect(created.status).toBe(201);
  setId = "set-appr";
  const meta = store.getMeta("assumption-sets", setId);
  setFileHash = meta.contentHash;
  setBindingsHash = String(meta.bindingsContentHash);
  for (const id of ["plan-none", "plan-chg", "plan-ro", "plan-mono", "plan-note"]) {
    store.putDocument("run-plans", id, { planId: id, label: id }, { label: id });
  }
}, 120_000);

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await tp.close();
});

describe("approvals routes", () => {
  it("GET /api/approvals on an empty store returns []", async () => {
    const r = await api<Rec[]>(tp.base, "GET", "/api/approvals");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("approving a stored assumption set at its file hash returns 201 with a server-assigned id and stamp", async () => {
    const before = readFileSync(store.paths.documentPath("assumption-sets", setId), "utf8");
    const r = await api<Rec>(
      tp.base,
      "POST",
      "/api/approvals",
      body({ artifactCollection: "assumption-sets", artifactId: setId, artifactContentHash: setFileHash, note: "  ok " }),
    );
    expect(r.status).toBe(201);
    const rec = r.body;
    expect(rec.id).toMatch(/^apr-\d{8}T\d{9}Z-[0-9a-f]{6}$/);
    expect(rec.id.slice(4, 4 + 19)).toBe(rec.at.replace(/[-:.]/g, ""));
    expect(rec.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(rec.note).toBe("ok");
    expect(Object.keys(rec)).toEqual([
      "id", "artifactCollection", "artifactId", "artifactContentHash", "decision", "by", "at", "note",
    ]);
    // The file bytes are serializeDocument of the record in exactly that field order.
    const onDisk = readFileSync(store.paths.documentPath("approvals", rec.id), "utf8");
    expect(onDisk).toBe(serializeDocument(rec));
    const meta = store.getMeta("approvals", rec.id);
    expect(meta.artifactCollection).toBe("assumption-sets");
    expect(meta.artifactId).toBe(setId);
    expect(meta.decision).toBe("approved");
    // The artifact itself is untouched.
    expect(readFileSync(store.paths.documentPath("assumption-sets", setId), "utf8")).toBe(before);
    // Readable back by id and in the listing.
    const one = await api<Rec>(tp.base, "GET", `/api/approvals/${rec.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toEqual(rec);
    const list = await api<Rec[]>(tp.base, "GET", "/api/approvals");
    expect(list.body.map((x) => x.id)).toContain(rec.id);
    expect((await status("assumption-sets", setId)).state).toBe("approved");
  });

  it("refuses the assumption-set bindings hash with 409 and both hashes in the message", async () => {
    expect(setBindingsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(setBindingsHash).not.toBe(setFileHash);
    const r = await api<Err>(
      tp.base,
      "POST",
      "/api/approvals",
      body({ artifactCollection: "assumption-sets", artifactId: setId, artifactContentHash: setBindingsHash }),
    );
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain(setBindingsHash);
    expect(r.body.error.message).toContain(setFileHash);
    expect(r.body.error.message).toContain("changed since it was reviewed");
  });

  it("answers 404 for an unknown artifact id", async () => {
    const r = await api<Err>(tp.base, "POST", "/api/approvals", body({ artifactId: "no-such-plan", artifactContentHash: "1".repeat(64) }));
    expect(r.status).toBe(404);
    const s = await api<Err>(tp.base, "GET", "/api/approvals/status/run-plans/no-such-plan");
    expect(s.status).toBe(404);
    const run = await api<Err>(tp.base, "POST", "/api/approvals", body({ artifactCollection: "runs", artifactId: "no-such-run", artifactContentHash: "1".repeat(64) }));
    expect(run.status).toBe(404);
  });

  it("answers 400 for a client id or stamp and 422 for a target outside the three", async () => {
    const withId = await api<Err>(tp.base, "POST", "/api/approvals", { ...body({}), id: "apr-mine" });
    expect(withId.status).toBe(400);
    expect(withId.body.error.message).toContain("server assigns id and at");
    const lens = await api<Err>(tp.base, "POST", "/api/approvals", body({ artifactCollection: "lens", artifactId: "rate-demo-v1" }));
    expect(lens.status).toBe(422);
    expect(lens.body.error.message).toContain("runs, run-plans, assumption-sets");
    const st = await api<Err>(tp.base, "GET", "/api/approvals/status/lens/rate-demo-v1");
    expect(st.status).toBe(422);
    const badId = await api<Err>(tp.base, "GET", "/api/approvals/status/run-plans/a%20b");
    expect(badId.status).toBe(422);
  });

  it("refuses a run that is not done with 409 naming its state", async () => {
    putRun("run-running", "running");
    const r = await api<Err>(tp.base, "POST", "/api/approvals", body({ artifactCollection: "runs", artifactId: "run-running", artifactContentHash: "1".repeat(64) }));
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain('run "run-running" is running');
    expect((await api(tp.base, "GET", "/api/approvals/status/runs/run-running")).status).toBe(409);
  });

  it("refuses a done run with no result.json with 409 saying result.json is missing", async () => {
    putRun("run-done-noresult", "done");
    const before = approvalFiles();
    const r = await api<Err>(tp.base, "POST", "/api/approvals", body({ artifactCollection: "runs", artifactId: "run-done-noresult", artifactContentHash: "1".repeat(64) }));
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain('run "run-done-noresult" is done but its result.json is missing');
    expect(r.body.error.message).not.toContain("only a finished run");
    const st = await api<Err>(tp.base, "GET", "/api/approvals/status/runs/run-done-noresult");
    expect(st.status).toBe(409);
    expect(st.body.error.message).toContain('run "run-done-noresult" is done but its result.json is missing');
    expect(st.body.error.message).not.toContain("only a finished run");
    expect(approvalFiles()).toEqual(before);
  });

  it("approves a done run at the sha256 of its result.json bytes", async () => {
    const result = '{"schemaVersion":"1","note":"fixture result"}\n';
    putRun("run-done", "done", result);
    const r = await api<Rec>(tp.base, "POST", "/api/approvals", body({ artifactCollection: "runs", artifactId: "run-done", artifactContentHash: sha(result) }));
    expect(r.status).toBe(201);
    expect(r.body.artifactContentHash).toBe(sha(result));
    expect((await status("runs", "run-done")).state).toBe("approved");
  });

  it("refuses a revocation with no approval at the hash with 409", async () => {
    const hash = sha(store.getDocumentBytes("run-plans", "plan-none"));
    const r = await api<Err>(tp.base, "POST", "/api/approvals", body({ artifactId: "plan-none", artifactContentHash: hash, decision: "revoked" }));
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain("nothing to revoke at this content hash");
  });

  it("reads none for an untouched run plan", async () => {
    const s = await status("run-plans", "plan-none");
    expect(s.state).toBe("none");
    expect(s.latest).toBeNull();
    expect(s.records).toEqual([]);
    expect(s.currentContentHash).toBe(sha(store.getDocumentBytes("run-plans", "plan-none")));
  });

  it("approve then revoke then approve again moves the state approved, revoked, approved; earlier files stay byte-identical", async () => {
    const hash = sha(store.getDocumentBytes("run-plans", "plan-ro"));
    const post = (decision: string) =>
      api<Rec>(tp.base, "POST", "/api/approvals", body({ artifactId: "plan-ro", artifactContentHash: hash, decision }));
    const a = await post("approved");
    expect(a.status).toBe(201);
    const filesAfterApprove = approvalFiles();
    const rv = await post("revoked");
    expect(rv.status).toBe(201);
    expect(rv.body.decision).toBe("revoked");
    const s1 = await status("run-plans", "plan-ro");
    expect(s1.state).toBe("revoked");
    expect(s1.latest!.id).toBe(rv.body.id);
    expect(s1.records.map((x) => x.id)).toEqual([a.body.id, rv.body.id]);
    // Earlier files are byte-identical after the revoke.
    const filesAfterRevoke = approvalFiles();
    for (const [name, bytes] of Object.entries(filesAfterApprove)) expect(filesAfterRevoke[name]).toBe(bytes);
    // A second revoke has nothing live to revoke.
    expect((await post("revoked")).status).toBe(409);
    const again = await post("approved");
    expect(again.status).toBe(201);
    expect((await status("run-plans", "plan-ro")).state).toBe("approved");
    // A co-sign while approved is allowed.
    expect((await post("approved")).status).toBe(201);
    expect((await status("run-plans", "plan-ro")).state).toBe("approved");
  });

  it("stamps strictly after the newest stored record when the clock is pinned: same-millisecond revoke wins, then re-approve wins", async () => {
    const hash = sha(store.getDocumentBytes("run-plans", "plan-mono"));
    const post = (decision: string, over: Record<string, unknown> = {}) =>
      api<Rec>(tp.base, "POST", "/api/approvals", body({ artifactId: "plan-mono", artifactContentHash: hash, decision, ...over }));
    // Pinned past every stamp the earlier tests stored (real time), so the expected stamps are exact.
    // Only Date is faked: the HTTP stack keeps its real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-02T12:00:00.000Z"));
    const a = await post("approved");
    const rv = await post("revoked");
    expect(a.status).toBe(201);
    expect(rv.status).toBe(201);
    expect(a.body.at).toBe("2030-01-02T12:00:00.000Z");
    expect(rv.body.at).toBe("2030-01-02T12:00:00.001Z");
    expect(rv.body.id.slice(4, 4 + 19)).toBe("20300102T120000001Z");
    expect((await status("run-plans", "plan-mono")).state).toBe("revoked");
    const again = await post("approved");
    expect(again.body.at).toBe("2030-01-02T12:00:00.002Z");
    expect((await status("run-plans", "plan-mono")).state).toBe("approved");
    // A clock stepped back behind the newest stored stamp still moves forward.
    vi.setSystemTime(new Date("2029-12-31T11:59:59.000Z"));
    const rv2 = await post("revoked");
    expect(rv2.body.at).toBe("2030-01-02T12:00:00.003Z");
    expect((await status("run-plans", "plan-mono")).state).toBe("revoked");
    // The server picks the stamps, listed oldest first.
    const list = await api<Rec[]>(tp.base, "GET", "/api/approvals");
    const mono = list.body.filter((x) => x.artifactId === "plan-mono");
    expect(mono.map((x) => x.at)).toEqual([
      "2030-01-02T12:00:00.000Z",
      "2030-01-02T12:00:00.001Z",
      "2030-01-02T12:00:00.002Z",
      "2030-01-02T12:00:00.003Z",
    ]);
  });

  it("refuses a note with a control character with 422 and accepts one with newline and tab", async () => {
    const hash = sha(store.getDocumentBytes("run-plans", "plan-note"));
    const bad = await api<Err>(
      tp.base, "POST", "/api/approvals",
      body({ artifactId: "plan-note", artifactContentHash: hash, note: "bell\u0007here" }),
    );
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toContain("note must not contain control characters");
    const ok = await api<Rec>(
      tp.base, "POST", "/api/approvals",
      body({ artifactId: "plan-note", artifactContentHash: hash, note: "line one\n\tline two" }),
    );
    expect(ok.status).toBe(201);
    expect(ok.body.note).toBe("line one\n\tline two");
  });

  it("reads changed after the seed supersedes the document and writes new content under the same id", async () => {
    const oldHash = sha(store.getDocumentBytes("run-plans", "plan-chg"));
    const a = await api<Rec>(tp.base, "POST", "/api/approvals", body({ artifactId: "plan-chg", artifactContentHash: oldHash }));
    expect(a.status).toBe(201);
    const next = { planId: "plan-chg", label: "plan-chg revised" };
    store.supersedeDocument("run-plans", "plan-chg", "stamp-chg", sha(serializeDocument(next)));
    store.putDocument("run-plans", "plan-chg", next, { label: "plan-chg revised" });
    const s = await status("run-plans", "plan-chg");
    expect(s.state).toBe("changed");
    expect(s.currentContentHash).toBe(sha(serializeDocument(next)));
    expect(s.latest!.id).toBe(a.body.id);
    // The old hash no longer matches, so approving it is refused.
    const stale = await api<Err>(tp.base, "POST", "/api/approvals", body({ artifactId: "plan-chg", artifactContentHash: oldHash }));
    expect(stale.status).toBe(409);
  });

  it("GET /api/approvals/:id answers 404 for an unknown id", async () => {
    expect((await api(tp.base, "GET", "/api/approvals/apr-nope")).status).toBe(404);
  });

  it("has no PUT or DELETE route: both answer the no-route 404 and the files are unchanged", async () => {
    const before = approvalFiles();
    const id = Object.keys(before).find((f) => !f.endsWith(".meta.json"))!.replace(/\.json$/, "");
    const put = await api<Err>(tp.base, "PUT", `/api/approvals/${id}`, { by: "x" });
    expect(put.status).toBe(404);
    expect(put.body.error.message).toContain(`no route for PUT /api/approvals/${id}`);
    const del = await api<Err>(tp.base, "DELETE", `/api/approvals/${id}`);
    expect(del.status).toBe(404);
    expect(approvalFiles()).toEqual(before);
  });
});

describe("approvals stay out of the database mirror and lineage", () => {
  it("syncStoreToDb runs clean with approvals present, holds no approvals row, and lineage is unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "alm-approvals-sync-"));
    try {
      const s = new FileStore(root);
      s.init();
      s.putDocument("run-plans", "plan-s", { planId: "plan-s" }, { label: "plan-s" });
      const hash = sha(s.getDocumentBytes("run-plans", "plan-s"));
      s.putDocument(
        "approvals",
        "apr-20261002T100000000Z-aaaaaa",
        {
          id: "apr-20261002T100000000Z-aaaaaa",
          artifactCollection: "run-plans",
          artifactId: "plan-s",
          artifactContentHash: hash,
          decision: "approved",
          by: "A. Reviewer",
          at: "2026-10-02T10:00:00.000Z",
          note: "",
        },
        { artifactCollection: "run-plans", artifactId: "plan-s", decision: "approved" },
      );
      const db = openPlatformDb(defaultDbPath(root));
      try {
        const report = syncStoreToDb(s, db);
        expect(report.runsIngested).toEqual([]);
        const rows = db.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE collection = 'approvals'").get() as { n: number };
        expect(rows.n).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect([...LINEAGE_COLLECTIONS]).toEqual(["portfolios", "market", "scenario-slates", "assumption-sets"]);
  });
});

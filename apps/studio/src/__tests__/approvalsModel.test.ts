// apps/studio/src/__tests__/approvalsModel.test.ts
/** The Approvals page's pure model (Controls 2, controls-approvals-studio). Expected strings are restated here. */
import { describe, expect, it } from "vitest";
import type { ApprovalRecord, ApprovalStatus } from "@alm/reader";
import { TARGET_LABEL, recordBlock, recordRows, stateLine } from "../controls/approvalsModel";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function rec(id: string, at: string, decision: "approved" | "revoked", over: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return { id, artifactCollection: "run-plans", artifactId: "plan-1", artifactContentHash: HASH_A, decision, by: "A. Reviewer", at, note: "", ...over };
}

function status(state: ApprovalStatus["state"], latest: ApprovalRecord | null = null): ApprovalStatus {
  return { artifactCollection: "run-plans", artifactId: "plan-1", currentContentHash: HASH_A, state, latest, records: latest === null ? [] : [latest] };
}

describe("TARGET_LABEL", () => {
  it("names the three targets in words", () => {
    expect(TARGET_LABEL).toEqual({ runs: "Run result", "run-plans": "Run plan", "assumption-sets": "Assumption set" });
  });
});

describe("recordRows", () => {
  const records = [
    rec("apr-20261002T100000000Z-aaaaaa", "2026-10-02T10:00:00.000Z", "approved", { note: "first" }),
    rec("apr-20261002T110000000Z-bbbbbb", "2026-10-02T11:00:00.000Z", "revoked", { artifactCollection: "assumption-sets", artifactId: "set-9", artifactContentHash: HASH_B, by: "B. Owner" }),
    rec("apr-20261002T120000000Z-cccccc", "2026-10-02T12:00:00.000Z", "approved", { artifactCollection: "runs", artifactId: "run-7" }),
  ];
  const rows = recordRows(records);

  it("orders newest first and does not change the input order", () => {
    expect(rows.map((r) => r.id)).toEqual(["apr-20261002T120000000Z-cccccc", "apr-20261002T110000000Z-bbbbbb", "apr-20261002T100000000Z-aaaaaa"]);
    expect(records[0]!.id).toBe("apr-20261002T100000000Z-aaaaaa");
  });
  it("maps approved to status-pass and revoked to status-breach with the decision word present", () => {
    expect(rows.map((r) => r.statusClass)).toEqual(["status status-pass", "status status-breach", "status status-pass"]);
    expect(rows.map((r) => r.decisionText)).toEqual(["✓ approved", "✕ revoked", "✓ approved"]);
  });
  it("names the artifact by its target word and id, and carries hash, by and note verbatim", () => {
    expect(rows.map((r) => r.artifactText)).toEqual(["Run result run-7", "Assumption set set-9", "Run plan plan-1"]);
    expect(rows[1]!.hash).toBe(HASH_B);
    expect(rows[1]!.by).toBe("B. Owner");
    expect(rows[2]!.note).toBe("first");
    expect(rows[2]!.at).toBe("2026-10-02T10:00:00.000Z");
  });
  it("an empty list gives no rows", () => {
    expect(recordRows([])).toEqual([]);
  });
});

describe("stateLine", () => {
  it("returns the four exact sentences", () => {
    expect(stateLine(status("approved", rec("apr-x", "2026-10-02T10:00:00.000Z", "approved"))).text).toBe("Approved at this content hash");
    expect(stateLine(status("revoked", rec("apr-x", "2026-10-02T10:00:00.000Z", "revoked"))).text).toBe("Revoked at this content hash");
    expect(stateLine(status("changed", rec("apr-x", "2026-10-02T10:00:00.000Z", "approved", { artifactContentHash: HASH_B }))).text).toBe("Records exist only for an earlier content hash; this content has none");
    expect(stateLine(status("none")).text).toBe("No record for this artifact");
  });
  it("uses the existing status classes, and muted for none", () => {
    expect(stateLine(status("approved")).cls).toBe("status status-pass");
    expect(stateLine(status("revoked")).cls).toBe("status status-breach");
    expect(stateLine(status("changed")).cls).toBe("status status-unobs");
    expect(stateLine(status("none")).cls).toBe("muted");
  });
});

describe("recordBlock", () => {
  const ok = { target: "run-plans" as const, artifactId: "plan-1", by: "A. Reviewer", note: "" };
  const approved = status("approved", rec("apr-x", "2026-10-02T10:00:00.000Z", "approved"));

  it("returns each of the four reasons", () => {
    expect(recordBlock({ ...ok, artifactId: "" }, approved, "approved")).toBe("Choose an artifact first");
    expect(recordBlock(ok, null, "approved")).toBe("Reading the artifact status");
    expect(recordBlock({ ...ok, by: "   " }, approved, "approved")).toBe("Type a name in Recorded by");
    expect(recordBlock(ok, status("none"), "revoked")).toBe("Nothing to revoke: this content hash is not approved");
  });
  it("checks the artifact before the status, and the status before the name", () => {
    expect(recordBlock({ ...ok, artifactId: "", by: "" }, null, "approved")).toBe("Choose an artifact first");
    expect(recordBlock({ ...ok, by: "" }, null, "approved")).toBe("Reading the artifact status");
  });
  it("lets a valid approval through, in any state", () => {
    for (const s of ["approved", "revoked", "changed", "none"] as const) expect(recordBlock(ok, status(s), "approved"), s).toBeNull();
  });
  it("blocks a revocation unless the state is approved", () => {
    for (const s of ["revoked", "changed", "none"] as const) expect(recordBlock(ok, status(s), "revoked"), s).toBe("Nothing to revoke: this content hash is not approved");
    expect(recordBlock(ok, approved, "revoked")).toBeNull();
  });
});

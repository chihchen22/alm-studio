/**
 * Controls 2 (approvals): the pure rules. approvalState decides the state of an
 * artifact from its records and its current content hash; parseApprovalBody is
 * the body gate; approvalId builds the server-assigned id from the stamp.
 *
 * Expected states, ids and status codes are restated here, not imported.
 */
import { describe, expect, it } from "vitest";
import { ID_PATTERN } from "../store/paths";
import { HttpError } from "../http/errors";
import {
  approvalId,
  approvalState,
  nextApprovalStampMs,
  parseApprovalBody,
  type ApprovalRecord,
} from "../approvals/approvals";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

function rec(over: Partial<ApprovalRecord> & { id: string; at: string }): ApprovalRecord {
  return {
    artifactCollection: "run-plans",
    artifactId: "plan-1",
    artifactContentHash: H1,
    decision: "approved",
    by: "A. Reviewer",
    note: "",
    ...over,
  };
}

const T1 = "2026-10-02T10:00:00.000Z";
const T2 = "2026-10-02T11:00:00.000Z";
const T3 = "2026-10-02T12:00:00.000Z";

describe("approvalState", () => {
  it("is none when there are no records", () => {
    expect(approvalState([], H1)).toEqual({ state: "none", latest: null });
  });

  it("is approved for one approval at the current hash", () => {
    const a = rec({ id: "apr-1", at: T1 });
    expect(approvalState([a], H1)).toEqual({ state: "approved", latest: a });
  });

  it("is revoked for approve then revoke", () => {
    const a = rec({ id: "apr-1", at: T1 });
    const r = rec({ id: "apr-2", at: T2, decision: "revoked" });
    const s = approvalState([a, r], H1);
    expect(s.state).toBe("revoked");
    expect(s.latest).toEqual(r);
  });

  it("is approved again for approve, revoke, approve", () => {
    const a = rec({ id: "apr-1", at: T1 });
    const r = rec({ id: "apr-2", at: T2, decision: "revoked" });
    const b = rec({ id: "apr-3", at: T3 });
    const s = approvalState([a, r, b], H1);
    expect(s.state).toBe("approved");
    expect(s.latest).toEqual(b);
  });

  it("a revocation cancels the earlier co-signs: approve A, approve B, revoke is revoked", () => {
    const a = rec({ id: "apr-1", at: T1, by: "A" });
    const b = rec({ id: "apr-2", at: T2, by: "B" });
    const r = rec({ id: "apr-3", at: T3, decision: "revoked" });
    expect(approvalState([a, b, r], H1).state).toBe("revoked");
  });

  it("is changed when records exist only at a different hash, latest the newest of them", () => {
    const a = rec({ id: "apr-1", at: T1, artifactContentHash: H2 });
    const b = rec({ id: "apr-2", at: T2, artifactContentHash: H2, decision: "revoked" });
    const s = approvalState([b, a], H1);
    expect(s.state).toBe("changed");
    expect(s.latest).toEqual(b);
  });

  it("ignores records at another hash when the current hash has its own", () => {
    const old = rec({ id: "apr-9", at: T3, artifactContentHash: H2, decision: "revoked" });
    const cur = rec({ id: "apr-1", at: T1 });
    expect(approvalState([old, cur], H1)).toEqual({ state: "approved", latest: cur });
  });

  it("orders by id when the stamps tie", () => {
    const a = rec({ id: "apr-20261002T100000000Z-000001", at: T1 });
    const r = rec({ id: "apr-20261002T100000000Z-000002", at: T1, decision: "revoked" });
    expect(approvalState([r, a], H1).state).toBe("revoked");
    expect(approvalState([a, r], H1).state).toBe("revoked");
  });
});

describe("nextApprovalStampMs", () => {
  const T1MS = Date.parse(T1);
  it("is the clock when it is ahead of every stored stamp", () => {
    expect(nextApprovalStampMs(T1MS + 5, [rec({ id: "apr-1", at: T1 })])).toBe(T1MS + 5);
    expect(nextApprovalStampMs(T1MS, [])).toBe(T1MS);
  });
  it("is one millisecond past the newest stored stamp when the clock ties it", () => {
    const stored = [rec({ id: "apr-1", at: T1 }), rec({ id: "apr-2", at: T1 })];
    expect(nextApprovalStampMs(T1MS, stored)).toBe(T1MS + 1);
  });
  it("is one millisecond past a stored stamp that is ahead of the clock (clock stepped back)", () => {
    expect(nextApprovalStampMs(T1MS - 60_000, [rec({ id: "apr-1", at: T1 })])).toBe(T1MS + 1);
  });
  it("makes approve then revoke at an equal clock read revoked even when the random suffix sorts the other way", () => {
    const a = rec({ id: approvalId(T1, "ff0000"), at: T1 });
    const revAt = new Date(nextApprovalStampMs(T1MS, [a])).toISOString();
    const r = rec({ id: approvalId(revAt, "000001"), at: revAt, decision: "revoked" });
    expect(revAt).toBe("2026-10-02T10:00:00.001Z");
    expect(approvalState([a, r], H1).state).toBe("revoked");
    const againAt = new Date(nextApprovalStampMs(T1MS, [a, r])).toISOString();
    expect(againAt).toBe("2026-10-02T10:00:00.002Z");
    const b = rec({ id: approvalId(againAt, "000000"), at: againAt });
    expect(approvalState([a, r, b], H1).state).toBe("approved");
  });
});

describe("approvalId", () => {
  it("strips dashes, colons and the dot from the stamp and appends the suffix", () => {
    const id = approvalId("2026-10-02T14:30:05.123Z", "a1b2c3");
    expect(id).toBe("apr-20261002T143005123Z-a1b2c3");
    expect(ID_PATTERN.test(id)).toBe(true);
    expect(id).toHaveLength(30);
  });
});

const good = {
  artifactCollection: "assumption-sets",
  artifactId: "set-1",
  artifactContentHash: H1,
  decision: "approved",
  by: "  A. Reviewer ",
  note: "  looks right ",
};

function statusOf(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e;
  }
  return 0;
}

describe("parseApprovalBody", () => {
  it("trims by and note and returns the six fields", () => {
    expect(parseApprovalBody(good)).toEqual({
      artifactCollection: "assumption-sets",
      artifactId: "set-1",
      artifactContentHash: H1,
      decision: "approved",
      by: "A. Reviewer",
      note: "looks right",
    });
  });

  it("defaults a missing note to the empty string", () => {
    const { note: _n, ...rest } = good;
    expect(parseApprovalBody(rest).note).toBe("");
  });

  it("refuses a body that is not an object with 400", () => {
    expect(statusOf(() => parseApprovalBody(null))).toBe(400);
    expect(statusOf(() => parseApprovalBody([]))).toBe(400);
    expect(statusOf(() => parseApprovalBody("x"))).toBe(400);
  });

  it("refuses an unknown key, id and at included, with 400 saying the server assigns them", () => {
    expect(statusOf(() => parseApprovalBody({ ...good, at: "2026-10-02T00:00:00.000Z" }))).toBe(400);
    expect(statusOf(() => parseApprovalBody({ ...good, id: "apr-x" }))).toBe(400);
    expect(statusOf(() => parseApprovalBody({ ...good, role: "ALCO" }))).toBe(400);
    expect(() => parseApprovalBody({ ...good, at: "x" })).toThrow(/server assigns id and at/);
  });

  it("refuses a wrong type with 400", () => {
    expect(statusOf(() => parseApprovalBody({ ...good, by: 5 }))).toBe(400);
    expect(statusOf(() => parseApprovalBody({ ...good, note: 5 }))).toBe(400);
    expect(statusOf(() => parseApprovalBody({ ...good, artifactId: undefined }))).toBe(400);
  });

  it("refuses a decision outside approved and revoked with 422", () => {
    expect(statusOf(() => parseApprovalBody({ ...good, decision: "rejected" }))).toBe(422);
  });

  it("refuses a target outside the three with 422 naming them", () => {
    expect(statusOf(() => parseApprovalBody({ ...good, artifactCollection: "lens" }))).toBe(422);
    expect(() => parseApprovalBody({ ...good, artifactCollection: "lens" })).toThrow(
      /runs, run-plans, assumption-sets/,
    );
  });

  it("refuses a bad artifact id with 422", () => {
    expect(statusOf(() => parseApprovalBody({ ...good, artifactId: "a/b" }))).toBe(422);
  });

  it("refuses a hash that is not 64 lowercase hex with 422", () => {
    expect(statusOf(() => parseApprovalBody({ ...good, artifactContentHash: "ABC" }))).toBe(422);
    expect(statusOf(() => parseApprovalBody({ ...good, artifactContentHash: "A".repeat(64) }))).toBe(422);
  });

  it("refuses by that is blank, over 80 chars or holds a control character with 422", () => {
    expect(statusOf(() => parseApprovalBody({ ...good, by: "   " }))).toBe(422);
    expect(statusOf(() => parseApprovalBody({ ...good, by: "x".repeat(81) }))).toBe(422);
    expect(statusOf(() => parseApprovalBody({ ...good, by: "x".repeat(80) }))).toBe(0);
    expect(statusOf(() => parseApprovalBody({ ...good, by: "a\u0007b" }))).toBe(422);
    expect(statusOf(() => parseApprovalBody({ ...good, by: "a\nb" }))).toBe(422);
  });

  it("refuses a note over 500 chars after trim with 422", () => {
    expect(statusOf(() => parseApprovalBody({ ...good, note: "n".repeat(501) }))).toBe(422);
    expect(statusOf(() => parseApprovalBody({ ...good, note: "n".repeat(500) }))).toBe(0);
  });

  it("refuses a note holding a control character with 422 but allows newline and tab", () => {
    expect(statusOf(() => parseApprovalBody({ ...good, note: "a\u0007b" }))).toBe(422);
    expect(statusOf(() => parseApprovalBody({ ...good, note: "a\u0000b" }))).toBe(422);
    expect(statusOf(() => parseApprovalBody({ ...good, note: "a\u009fb" }))).toBe(422);
    expect(statusOf(() => parseApprovalBody({ ...good, note: "line one\nline two\tend" }))).toBe(0);
    expect(parseApprovalBody({ ...good, note: "line one\nline two\tend" }).note).toBe("line one\nline two\tend");
  });
});

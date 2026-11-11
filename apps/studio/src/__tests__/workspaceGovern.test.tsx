// apps/studio/src/__tests__/workspaceGovern.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { HistoryLine, WorkspaceManifest } from "@alm/reader";
import { changeText, cloneTree, historyRows, signOffBlock, supersedeLinks } from "../govern/workspaceGovern";
import { WorkspaceHistoryCard, WorkspaceLineageCard, WorkspaceSignOffView } from "../pages/govern/WorkspaceGovern";
import { HEAD } from "./fixtures/workspace";

const W = (over: Partial<WorkspaceManifest> & { id: string }): WorkspaceManifest => ({ ...HEAD, name: over.id, ...over });

const ROOT = W({ id: "ws-prod-2026-02", name: "February production", type: "production", cutoffDate: "2026-02-28", lineage: { ...HEAD.lineage, mode: "blank", supersededBy: "ws-prod-2026-02-v2" } });
const FIX = W({ id: "ws-prod-2026-02-v2", name: "February production, corrected", type: "production", cutoffDate: "2026-02-28", lineage: { ...HEAD.lineage, mode: "supersede", fromWorkspaceId: "ws-prod-2026-02", fromSignedHash: "sh-1", carried: ["market", "positions"] } });
const ROLL = W({ id: "ws-monthly-2026-03", name: "March monthly", type: "monthly", cutoffDate: "2026-03-31", lineage: { ...HEAD.lineage, mode: "roll-forward", fromWorkspaceId: "ws-prod-2026-02-v2", fromSignedHash: "sh-2" } });
const ALL = [ROOT, FIX, ROLL, HEAD];

describe("clone tree and supersede links", () => {
  it("walks the ancestors from the root and lists the descendants with their depth", () => {
    const t = cloneTree(FIX, ALL);
    expect(t.ancestors.map((n) => n.id)).toEqual(["ws-prod-2026-02"]);
    expect(t.descendants.map((n) => [n.id, n.depth])).toEqual([["ws-monthly-2026-03", 1]]);
  });
  it("does not loop on a malformed cycle", () => {
    const a = W({ id: "ws-a", lineage: { ...HEAD.lineage, fromWorkspaceId: "ws-b" } });
    const b = W({ id: "ws-b", lineage: { ...HEAD.lineage, fromWorkspaceId: "ws-a" } });
    expect(cloneTree(a, [a, b]).ancestors.map((n) => n.id)).toEqual(["ws-b"]);
  });
  it("reads the supersede links off the lineage", () => {
    expect(supersedeLinks(ROOT, ALL)).toEqual({ supersededBy: "ws-prod-2026-02-v2", supersedes: null, pending: false });
    expect(supersedeLinks(FIX, ALL)).toEqual({ supersededBy: null, supersedes: "ws-prod-2026-02", pending: false });
  });
});

describe("history rows", () => {
  const line = (revision: number, change: HistoryLine["change"], by = "chih", reconciled?: true): HistoryLine => ({
    revision, at: `2026-10-0${revision}T10:00:00Z`, by, change, manifest: { ...HEAD, revision, signedHash: `signed-${revision}` }, ...(reconciled ? { reconciled } : {}),
  });
  it("says each change in words", () => {
    expect(changeText({ kind: "create" })).toBe("Created");
    expect(changeText({ kind: "set-block", block: "positions", op: "set", ref: { collection: "portfolios", id: "book-1" } })).toBe("Positions: set portfolios book-1");
    expect(changeText({ kind: "set-default", setId: "demo-behavioral-v1" })).toBe("Default assumption set: demo-behavioral-v1");
    expect(changeText({ kind: "lock", approvalId: "ap-1" })).toBe("Locked on approval ap-1");
    expect(changeText({ kind: "supersede", by: "ws-x" })).toBe("Superseded by ws-x");
    expect(changeText({ kind: "status", from: "active", to: "archived" })).toBe("Status active to archived");
    expect(changeText({ kind: "clash", block: "market", id: "m-1", documentAsOf: "2026-04-30" })).toBe("Cut-off clash recorded: market m-1 is dated 2026-04-30");
  });
  it("lists newest revision first and keeps the signed hash each revision held", () => {
    const rows = historyRows([line(1, { kind: "create" }), line(2, { kind: "set-default", setId: "s" }), line(3, { kind: "lock", approvalId: "ap-1" }, "chih", true)]);
    expect(rows.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(rows[0]).toMatchObject({ signedHash: "signed-3", reconciled: true, text: "Locked on approval ap-1" });
  });
  it("renders the table with the revision, who and what", () => {
    const html = renderToStaticMarkup(<WorkspaceHistoryCard lines={[line(1, { kind: "create" }), line(2, { kind: "meta", name: "Renamed" })]} />);
    expect(html).toContain("History");
    expect(html).toContain("Renamed");
    expect(html).toContain("chih");
    expect(html).toContain("Source: /api/workspaces/");
  });
});

describe("the lineage card", () => {
  it("shows the tree, the supersede link both ways and the pending note", () => {
    const html = renderToStaticMarkup(<WorkspaceLineageCard head={FIX} workspaces={ALL} />);
    expect(html).toContain("Supersedes");
    expect(html).toContain(`href="#/ws/ws-prod-2026-02/govern/lineage"`);
    expect(html).toContain("ws-monthly-2026-03");
    const old = renderToStaticMarkup(<WorkspaceLineageCard head={ROOT} workspaces={ALL} />);
    expect(old).toContain("Superseded by");
    expect(old).toContain(`href="#/ws/ws-prod-2026-02-v2/govern/lineage"`);
  });
});

describe("workspace sign-off", () => {
  const view = (head: WorkspaceManifest, by = "", over: Partial<Parameters<typeof WorkspaceSignOffView>[0]> = {}) => renderToStaticMarkup(
    <WorkspaceSignOffView head={head} by={by} note="" busy={false} error={null} notice={null} onBy={() => {}} onNote={() => {}} onSign={() => {}} {...over} />,
  );
  it("shows the current signedHash the sign-off will bind", () => {
    const html = view(HEAD, "chih");
    expect(html).toContain(HEAD.signedHash);
    expect(html).toContain("Sign off this workspace");
  });
  it("warns that a Production sign-off locks the workspace", () => {
    expect(view(W({ id: "ws-p", type: "production" }), "chih")).toContain("Signing a Production workspace locks it");
    expect(view(HEAD, "chih")).not.toContain("Signing a Production workspace locks it");
  });
  it("blocks with a reason when no name is typed or the workspace is not active", () => {
    expect(signOffBlock(HEAD, "")).toBe("Type your name to sign off.");
    expect(signOffBlock(HEAD, "chih")).toBeNull();
    expect(signOffBlock(W({ id: "ws-l", status: "locked" }), "chih")).toBe("This workspace is locked; a locked workspace takes no further sign-off. Clone it to change it.");
    expect(signOffBlock(W({ id: "ws-a", status: "archived" }), "chih")).toBe("This workspace is archived; an archived workspace takes no sign-off.");
    expect(signOffBlock(W({ id: "ws-s", status: "superseded" }), "chih")).toBe("This workspace is superseded; sign off the workspace that superseded it.");
  });
  it("prints the lock record on a locked head", () => {
    const locked = W({ id: "ws-l", type: "production", status: "locked", lock: { lockedAt: "2026-10-08T10:00:00Z", by: "chih", approvalId: "ap-9", signedHash: "sh-9" } });
    const html = view(locked, "chih");
    expect(html).toContain("ap-9");
    expect(html).toContain("sh-9");
    expect(html).toContain("aria-disabled");
  });
});

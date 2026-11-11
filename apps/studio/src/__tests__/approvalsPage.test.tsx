// apps/studio/src/__tests__/approvalsPage.test.tsx
/** The Approvals page view (Controls 2, controls-approvals-studio). Studio tests have no DOM: static markup only. */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApprovalRecord, ApprovalStatus } from "@alm/reader";
import { ApprovalsView, type ApprovalsViewProps } from "../pages/controls/ApprovalsPage";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

function rec(id: string, at: string, decision: "approved" | "revoked", hash = HASH_A): ApprovalRecord {
  return { id, artifactCollection: "run-plans", artifactId: "plan-1", artifactContentHash: hash, decision, by: "A. Reviewer", at, note: "checked" };
}

function status(state: ApprovalStatus["state"], latest: ApprovalRecord | null = null): ApprovalStatus {
  return { artifactCollection: "run-plans", artifactId: "plan-1", currentContentHash: HASH_B, state, latest, records: latest === null ? [] : [latest] };
}

const noop = () => undefined;
function props(over: Partial<ApprovalsViewProps> = {}): ApprovalsViewProps {
  return {
    records: [], recordsError: null,
    form: { target: "run-plans", artifactId: "plan-1", by: "A. Reviewer", note: "" },
    ids: ["plan-1", "plan-2"], idsError: null,
    status: status("none"), statusError: null,
    busy: false, actionError: null, notice: null,
    onTarget: noop, onArtifact: noop, onBy: noop, onNote: noop, onRecord: noop,
    ...over,
  };
}
const html = (over: Partial<ApprovalsViewProps> = {}) => renderToStaticMarkup(<ApprovalsView {...props(over)} />);

describe("ApprovalsView", () => {
  it("the top card states what the records are and are not", () => {
    const t = text(html());
    expect(t).toContain("Studio has no sign-in, so the name on a record is typed by whoever records it and Studio does not check it.");
    expect(t).toContain("not verified");
    expect(t).toContain("A record gates nothing: plans, sets and runs work the same with or without one.");
    expect(t).toContain("gates nothing");
    expect(t).toContain("Records are append-only: a revocation is a new record, and no record is edited or removed.");
    expect(t).toContain("append-only");
    expect(t).toContain("Source: /api/approvals");
  });

  it("prints the typed-name caveat in the column header and the form label", () => {
    const out = html({ records: [rec("apr-1", "2026-10-02T10:00:00.000Z", "approved")] });
    expect(out).toContain('<th scope="col">Recorded by (typed, not verified)</th>');
    expect(out).toContain("Recorded by (typed, not verified)</span>");
    for (const h of ["Recorded at (UTC)", "Decision", "Artifact", "Content hash", "Note"]) expect(text(out)).toContain(h);
  });

  it("prints one row per record, newest first, with the id and hash in mono", () => {
    const out = html({ records: [
      rec("apr-20261002T100000000Z-aaaaaa", "2026-10-02T10:00:00.000Z", "approved"),
      rec("apr-20261002T110000000Z-bbbbbb", "2026-10-02T11:00:00.000Z", "revoked", HASH_B),
    ] });
    const body = out.slice(out.indexOf("<tbody>"));
    expect(body.match(/<tr/g)).toHaveLength(2);
    expect(body.indexOf("apr-20261002T110000000Z-bbbbbb")).toBeLessThan(body.indexOf("apr-20261002T100000000Z-aaaaaa"));
    expect(out).toContain('<span class="mono">apr-20261002T110000000Z-bbbbbb</span>');
    expect(out).toContain(`<td class="mono">${HASH_B}</td>`);
    expect(out).toContain("✕ revoked");
    expect(out).toContain("✓ approved");
    expect(out).toContain("status status-breach");
    expect(out).toContain("status status-pass");
  });

  it("shows the empty-state line for no records", () => {
    const out = html({ records: [] });
    expect(text(out)).toContain("No approval record has been written yet.");
    expect(out).not.toContain("<tbody>");
  });

  it("a failed list read shows the error inline and the form still renders", () => {
    const out = html({ records: null, recordsError: "500: boom" });
    expect(out).toContain('role="alert"');
    expect(text(out)).toContain("500: boom");
    expect(out).toContain("Record approval");
  });

  it("the target select offers exactly the three targets, inside a field label", () => {
    const out = html();
    const sel = out.slice(out.indexOf("<select"), out.indexOf("</select>"));
    expect(sel.match(/<option/g)).toHaveLength(3);
    for (const w of ["Run result", "Run plan", "Assumption set"]) expect(sel).toContain(w);
    expect(out).toContain('<label class="field"><span class="field-label">Artifact type</span><select aria-label="Artifact type"');
    expect(sel).not.toContain("class=");
  });

  it("every control sits in a field label; text inputs use the input class", () => {
    const out = html();
    expect(out.match(/<label class="field">/g)).toHaveLength(4);
    expect(out.match(/class="field-label"/g)).toHaveLength(4);
    expect(out.match(/class="input input-text"/g)).toHaveLength(2);
    expect(out).not.toContain('class="select"');
    expect(out.match(/<select aria-label="[^"]+">/g)).toHaveLength(2);
  });

  it("the id select lists ids only", () => {
    const out = html({ ids: ["plan-1", "plan-2"] });
    expect(out).toContain('<option value="plan-2">plan-2</option>');
  });

  it("the status panel prints the current content hash and the state in words", () => {
    const out = html({ status: status("approved", rec("apr-1", "2026-10-02T10:00:00.000Z", "approved", HASH_B)) });
    const t = text(out);
    expect(out).toContain(`<span class="mono">${HASH_B}</span>`);
    expect(t).toContain("Approved at this content hash");
    expect(t).toContain("recorded by A. Reviewer (typed, not verified)");
    expect(t).toContain("2026-10-02T10:00:00.000Z");
  });

  it("the revocation button carries aria-disabled and the reason when the state is none", () => {
    const out = html({ status: status("none") });
    const revoke = out.slice(out.indexOf("Record revocation") - 300, out.indexOf("Record revocation"));
    expect(revoke).toContain('aria-disabled="true"');
    expect(text(out)).toContain("Nothing to revoke: this content hash is not approved");
    const approve = out.slice(out.indexOf("Record approval") - 300, out.indexOf("Record approval"));
    expect(approve).not.toContain("aria-disabled");
  });

  it("with no name typed, both buttons are off and say why", () => {
    const out = html({ form: { target: "run-plans", artifactId: "plan-1", by: "  ", note: "" } });
    expect(out.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(text(out)).toContain("Type a name in Recorded by");
  });

  it("the revocation button is on when the state is approved", () => {
    const out = html({ status: status("approved", rec("apr-1", "2026-10-02T10:00:00.000Z", "approved", HASH_B)) });
    expect(out).not.toContain("aria-disabled");
  });

  it("a record action's error and notice print in the right roles", () => {
    expect(html({ actionError: "409: changed since reviewed" })).toContain('role="alert"');
    expect(text(html({ actionError: "409: changed since reviewed" }))).toContain("409: changed since reviewed");
    const ok = html({ notice: "Recorded apr-1." });
    expect(ok).toContain('role="status"');
    expect(text(ok)).toContain("Recorded apr-1.");
  });

  it("prints no em-dash and no section sign", () => {
    const out = html({ records: [rec("apr-1", "2026-10-02T10:00:00.000Z", "approved")], status: status("changed", rec("apr-1", "2026-10-02T10:00:00.000Z", "approved")) });
    expect(out).not.toContain(String.fromCharCode(0x2014));
    expect(out).not.toContain(String.fromCharCode(0xa7));
  });
});

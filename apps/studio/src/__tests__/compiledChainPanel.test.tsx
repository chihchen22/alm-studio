// apps/studio/src/__tests__/compiledChainPanel.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CompiledChainPanel } from "../run/CompiledChainPanel";
import { FLAT_STAGES, RUNOFF_STAGES } from "./fixtures/stages";

const PASS = { type: { passed: true, failures: [], checked: ["T1"] }, routing: { passed: true, failures: [], checked: ["R1"] } };

describe("compiled chain panel", () => {
  it("lists every stage with id, component, kind, consumes, produces and dependsOn, and carries no editing affordance", () => {
    const html = renderToStaticMarkup(<CompiledChainPanel stages={FLAT_STAGES} gates={PASS} />);
    for (const s of FLAT_STAGES) { expect(html).toContain(s.id); expect(html).toContain(s.component); }
    expect(html).toMatch(/st-cashflow[\s\S]*st-balance[\s\S]*st-nii/);
    for (const bad of ["<button", "<input", "<select", "<textarea", "draggable", "contenteditable"]) expect(html).not.toContain(bad);
    expect(html).toContain("T1"); expect(html).toContain("R1");
  });

  it("prints kind, consumes, produces and dependsOn for a stage", () => {
    const html = renderToStaticMarkup(<CompiledChainPanel stages={FLAT_STAGES} gates={null} />);
    // st-balance: kind balance-new-business, consumes Position, RatePath, Cashflow, produces Cashflow, depends on st-cashflow and st-term.
    const row = html.slice(html.indexOf("st-balance"), html.indexOf("st-nii"));
    expect(row).toContain("balance-new-business");
    expect(row).toContain("Position, RatePath, Cashflow");
    expect(row).toContain("st-cashflow, st-term");
  });

  it("a Runoff chain has no st-balance", () => {
    expect(renderToStaticMarkup(<CompiledChainPanel stages={RUNOFF_STAGES} gates={null} />)).not.toContain("st-balance");
  });

  it("states the one visible difference only when the balance stage is there", () => {
    const flat = renderToStaticMarkup(<CompiledChainPanel stages={FLAT_STAGES} gates={null} />);
    const runoff = renderToStaticMarkup(<CompiledChainPanel stages={RUNOFF_STAGES} gates={null} />);
    expect(flat).toContain("st-balance sits between st-cashflow and st-nii");
    expect(runoff).not.toContain("sits between");
  });

  it("is read-only in words, and a failed gate prints its failures", () => {
    const failed = {
      type: { passed: false, failures: [{ gate: "type", rule: "T1", stageId: "st-nii", detail: "consumes Cashflow but nothing produces it" }], checked: ["T1 st-nii"] },
      routing: PASS.routing,
    };
    const html = renderToStaticMarkup(<CompiledChainPanel stages={RUNOFF_STAGES} gates={failed as never} />);
    expect(html).toContain("Read-only");
    expect(html).toContain("consumes Cashflow but nothing produces it");
    expect(html).toContain("Type gate");
    expect(html).toContain("Routing gate");
  });

  it("an empty chain says the roles did not resolve and draws no list", () => {
    const html = renderToStaticMarkup(<CompiledChainPanel stages={[]} gates={null} />);
    expect(html).toContain("No compiled chain");
    expect(html).not.toContain("<ol");
  });
});

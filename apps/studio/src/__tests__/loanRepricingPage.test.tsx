// apps/studio/src/__tests__/loanRepricingPage.test.tsx
/** The Loan repricing page. Studio tests have no DOM: static markup only. */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RateDocument } from "@alm/engine";
import { clientRateModel } from "../assumptions/clientRatePathModel";
import { ClientRateView, LoanRepricingPage } from "../pages/assumptions/LoanRepricingPage";

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const LINES = [
  "Flat carry: the total spread over the 10-year benchmark stays at its set value for the whole horizon.",
  "This equals the rate the prepayment refinance incentive computes for itself where a prepayment binding with both spreads applies.",
  "The client rate moves one for one with the 10-year benchmark from the first month. This is a modeling choice, and it overstates how fast offered rates follow market rates over the next year.",
  "No floor is applied: the client rate is the benchmark plus the spread in every month.",
  "No measure reads this rate yet: NII, EVE, gap and FTP are unchanged by it.",
  "Where a prepayment binding also applies, the total spread must equal its securitization plus primary spread.",
];
const BASIS = "Benchmark: the 10-year forward par yield on the run's curve, on the curve's own quote basis: semi-annual bond-equivalent basis (Treasury CMT on the public pack).";
const BANNED = ["reverting", "error-correction", "challenger", "fitted", "calibrated", "champion", "replaced", "superseded", "swap"];

const curve = { t: [1, 5, 10], z: [0.04, 0.042, 0.045], df: [0.96, 0.81, 0.64] };
const rates = new Array(24).fill(0.07); rates[0] = 0.0612; rates[11] = 0.0634;
const DOC = {
  schemaVersion: "1.1.0", kind: "rate-document", runId: "run-1", mode: "deterministic",
  grid: { horizonMonths: 24, dtYears: 1 / 12, asOf: "2026-03-31" }, base: curve,
  scenarios: [
    { scenarioId: "S0", rateSpecKind: "base", ratePathModel: "deterministic", curve, clientRates: [{
      assumptionSetId: "loan-repricing-demo-v1", familyId: "mortgages", model: "flat-carry", curveConvention: "semiannual_bond",
      benchmarkTenorYears: 10, totalSpreadBp: 250, benchmark: rates.map((r) => r - 0.025), clientRate: rates }] },
    { scenarioId: "S100", rateSpecKind: "parallel", ratePathModel: "hw1f-demo", curve, pathOmitted: "rate path model is not the deterministic built-in" },
  ],
} as unknown as RateDocument;

describe("ClientRateView", () => {
  const html = renderToStaticMarkup(<ClientRateView model={clientRateModel({ doc: DOC }, "run-1")} />);
  const t = text(html);
  it("shows the section title, the stored figures and the derived basis sentence", () => {
    expect(t).toContain("Projected client rate");
    expect(t).toContain("6.12%");
    expect(t).toContain("6.34%");
    expect(t).toContain("250 bp");
    expect(t).toContain("mortgages");
    expect(t).toContain("whole family");
    expect(t).toContain(BASIS);
    expect(t).toContain("rate path model is not the deterministic built-in");
  });
  it("carries the six plain lines verbatim, including the no-floor line", () => {
    for (const l of LINES) expect(t).toContain(l);
    expect(t).toContain("No floor is applied");
  });
  it("uses none of the barred words, no CMT outside the basis sentence, no em-dash and no section sign", () => {
    for (const w of BANNED) expect(t.toLowerCase(), w).not.toContain(w);
    expect(t.split(BASIS).join("")).not.toContain("CMT");
    expect(html).not.toContain(String.fromCharCode(0x2014));
    expect(html).not.toContain(String.fromCharCode(0xa7));
  });
  it("prints a state sentence under the lines and no table", () => {
    const h = renderToStaticMarkup(<ClientRateView model={clientRateModel({ doc: null }, "")} />);
    expect(text(h)).toContain("Pick a run to see its projected client rate.");
    expect(h).not.toContain("<table");
    for (const l of LINES) expect(text(h)).toContain(l);
  });
});

describe("LoanRepricingPage", () => {
  it("renders the stored-spread table region and the client rate section with the plain lines", () => {
    const html = renderToStaticMarkup(<LoanRepricingPage ws="ws-a" query={{ run: "run-1" }} />);
    const t = text(html);
    expect(t).toContain("Projected client rate");
    for (const l of LINES) expect(t).toContain(l);
    for (const w of BANNED) expect(t.toLowerCase(), w).not.toContain(w);
  });
});

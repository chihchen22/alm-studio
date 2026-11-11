/**
 * Console rendering for the scripted demo. Pure string assembly from a completed
 * RunResult: readable fixed-width tables for NII, EVE, and both gap ladders, the
 * provenance summary, the explain narration, and an explicit not-implemented
 * section. No number is computed here; every value is read straight off the
 * RunResult the engine produced.
 */
import type {
  Explanation,
  GapLadder,
  RunResult,
  ScenarioEVE,
  ScenarioNII,
} from "@alm/engine";
import type { NotImplemented } from "@alm/engine";

/** A right-aligned, thousands-separated whole-dollar string. */
function money(x: number): string {
  return Math.round(x).toLocaleString("en-US");
}

/** Fixed-decimal string, or a dash for undefined (a rejected/absent value). */
function dec(x: number | undefined, places: number): string {
  return x === undefined ? "-" : x.toFixed(places);
}

/**
 * Render an aligned table. `align[i] === "r"` right-pads the column; anything
 * else left-pads. Column width is the widest cell including the header.
 */
function table(headers: string[], rows: string[][], align: string[]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const pad = (s: string, i: number): string =>
    align[i] === "r" ? s.padStart(widths[i]) : s.padEnd(widths[i]);
  const line = (cells: string[]): string => cells.map((c, i) => pad(c, i)).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(headers), sep, ...rows.map(line)].join("\n");
}

function section(title: string): string {
  return `\n${"=".repeat(72)}\n  ${title}\n${"=".repeat(72)}`;
}

function bookSummary(
  result: RunResult,
  label: string,
  positionCount: number,
  totals: { assets: number; liabilities: number; equity: number },
): string {
  const grid = result.cashflows.grid;
  return [
    section("SYNTHETIC BOOK"),
    `  ${label}`,
    `  as of ${grid.asOf}   positions ${positionCount.toLocaleString("en-US")}   horizon ${grid.horizonMonths} months`,
    "",
    table(
      ["Balance sheet", "Amount ($)"],
      [
        ["Total assets", money(totals.assets)],
        ["Total liabilities", money(totals.liabilities)],
        ["Equity (plug)", money(totals.equity)],
      ],
      ["l", "r"],
    ),
  ].join("\n");
}

function provenanceSummary(result: RunResult): string {
  const p = result.provenance;
  const mv = Object.entries(p.modelVersions).map(([k, v]) => `${k} = ${v}`);
  const sets = p.assumptionSets.map((s) => `${s.id}  ${s.hash.slice(0, 16)}...`);
  return [
    section("PROVENANCE LEDGER"),
    table(
      ["Field", "Value"],
      [
        ["schemaVersion", result.schemaVersion],
        ["runId", p.runId],
        ["engineVersion", p.engineVersion],
        ["kernel commit", p.kernel.sourceCommit],
        ["kernel manifest hash", `${p.kernel.provenanceFileHash.slice(0, 16)}...`],
        ["inputsHash", `${p.inputsHash.slice(0, 16)}...`],
        ["seed", p.seed],
        ["startedAt", p.timestamps.startedAt],
        ["finishedAt", p.timestamps.finishedAt],
      ],
      ["l", "l"],
    ),
    "",
    "  Assumption sets:",
    ...sets.map((s) => `    ${s}`),
    "  Model versions:",
    ...mv.map((s) => `    ${s}`),
  ].join("\n");
}

function niiTable(byScenario: ScenarioNII[]): string {
  const rows = byScenario.map((s) => [
    s.scenarioId,
    money(s.totalNet12),
    money(s.totalNet24),
  ]);
  return [
    section("NET INTEREST INCOME (projected, $)"),
    table(["Scenario", "Net 12m", "Net 24m"], rows, ["l", "r", "r"]),
  ].join("\n");
}

function eveTable(byScenario: ScenarioEVE[]): string {
  const rows = byScenario.map((s) => {
    // A scenario whose duration block was not computed (base-only mode, a shocked
    // scenario) reports effectiveDurationEquity undefined with a
    // durationSanityPassed that is true only as a vacuous AND over zero gates. In
    // per-scenario mode an undefined equity duration always comes with a false
    // gate (the equity gate rejected it), so this pair uniquely marks base-only.
    // Render it as "n/a (base-only)" and do NOT print a bare "yes" that would read
    // as a shocked duration that passed sanity but was in fact never measured.
    const durationNotMeasured =
      s.effectiveDurationEquity === undefined && s.durationSanityPassed;
    return [
      s.scenarioId,
      money(s.pvAssets),
      money(s.pvLiabilities),
      money(s.eve),
      money(s.deltaEveVsBase),
      `${(s.deltaEvePct * 100).toFixed(2)}%`,
      durationNotMeasured ? "n/a (base-only)" : dec(s.effectiveDurationEquity, 3),
      durationNotMeasured ? "n/a" : s.durationSanityPassed ? "yes" : "no",
    ];
  });
  return [
    section("ECONOMIC VALUE OF EQUITY ($)"),
    table(
      ["Scenario", "PV assets", "PV liab", "EVE", "dEVE vs base", "dEVE %", "Dur(eq)", "SanityOK"],
      rows,
      ["l", "r", "r", "r", "r", "r", "r", "l"],
    ),
  ].join("\n");
}

function gapTable(ladder: GapLadder): string {
  const rows = ladder.rows.map((r) => [
    r.band.label,
    money(r.assets),
    money(r.liabilities),
    money(r.gap),
    money(r.cumulativeGap),
  ]);
  return [
    `\n  ${ladder.kind.toUpperCase()} GAP — scenario ${ladder.scenarioId} ($)`,
    table(
      ["Band", "Assets", "Liabilities", "Gap", "Cumulative"],
      rows,
      ["l", "r", "r", "r", "r"],
    ),
  ].join("\n");
}

function explainSection(explanation: Explanation, question: string): string {
  const lines = [section("EXPLAIN"), `  Q: ${question}`, ""];
  lines.push(`  supported: ${explanation.supported}`);
  lines.push(`  A: ${explanation.answer}`);
  if (explanation.citations.length > 0) {
    lines.push("  Citations (driver contributions):");
    for (const c of explanation.citations) {
      lines.push(`    ${c.familyId} / ${c.driver}: ${money(c.amount)}`);
    }
  }
  return lines.join("\n");
}

function notImplementedSection(tags: NotImplemented[]): string {
  const lines = [section("NOT IMPLEMENTED")];
  if (tags.length === 0) {
    lines.push("  none — every layer of this run produced a real value.");
  } else {
    for (const t of tags) lines.push(`  [${t.layer}] ${t.reason}`);
  }
  return lines.join("\n");
}

/** Assemble the full console report. `baseScenarioId` selects the gap ladders shown. */
export function renderReport(args: {
  result: RunResult;
  label: string;
  positionCount: number;
  totals: { assets: number; liabilities: number; equity: number };
  explanation: Explanation;
  explainQuestion: string;
  baseScenarioId: string;
}): string {
  const { result, baseScenarioId } = args;
  const repricing = result.gap.repricing.find((l) => l.scenarioId === baseScenarioId);
  const liquidity = result.gap.liquidity.find((l) => l.scenarioId === baseScenarioId);

  const parts = [
    bookSummary(result, args.label, args.positionCount, args.totals),
    provenanceSummary(result),
    niiTable(result.nii.byScenario),
    eveTable(result.eve.byScenario),
    section("GAP PROFILES"),
  ];
  if (repricing) parts.push(gapTable(repricing));
  if (liquidity) parts.push(gapTable(liquidity));
  parts.push(explainSection(args.explanation, args.explainQuestion));
  parts.push(notImplementedSection(result.notImplemented));
  return parts.join("\n");
}

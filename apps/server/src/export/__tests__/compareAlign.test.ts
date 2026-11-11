import { describe, expect, it } from "vitest";
import { alignCompare, renderCompareCsv, type CsvTable } from "../csv";

const cols: CsvTable["columns"] = [
  { name: "scenarioId", role: "key" },
  { name: "familyId", role: "key" },
  { name: "net12", role: "num" },
  { name: "note", role: "text" },
];
const A: CsvTable = { columns: cols, rows: [
  { scenarioId: "S0", familyId: "", net12: 10, note: "a" },
  { scenarioId: "S0", familyId: "dda", net12: 4.5, note: undefined },
  { scenarioId: "S100", familyId: "", net12: 7, note: "x" },
] };
const B: CsvTable = { columns: cols, rows: [
  { scenarioId: "S0", familyId: "", net12: 12.25, note: "b" },
  { scenarioId: "S0", familyId: "dda", net12: null, note: "c,d" },
  { scenarioId: "S200", familyId: "", net12: 3, note: "y" },
] };
const P = (id: string) => ({ runId: id, inputsHash: `h-${id}`, curve: `c, ${id}`, schemaVersion: "s", engineVersion: "e" });

const EXPECTED = [
  "# runId [A],ra", "# inputsHash [A],h-ra", '# curve [A],"c, ra"', "# schemaVersion [A],s", "# engineVersion [A],e",
  "# runId [B],rb", "# inputsHash [B],h-rb", '# curve [B],"c, rb"', "# schemaVersion [B],s", "# engineVersion [B],e",
  "# generatedAt,2026-09-26T00:00:00.000Z",
  '# note,"derived columns are B - A, displayed beside both originals"',
  "scenarioId,familyId,net12 [A],net12 [B],net12 [derived: B - A],note [A],note [B]",
  "S0,,10,12.25,2.25,a,b",
  'S0,dda,4.5,,,,"c,d"',
  "S100,,7,,,x,",
  "S200,,,3,,,y",
].join("\r\n") + "\r\n";

describe("compare alignment", () => {
  it("renders the frozen CSV bytes", () => {
    expect(renderCompareCsv({ table: A, prov: P("ra") }, { table: B, prov: P("rb") }, "2026-09-26T00:00:00.000Z")).toBe(EXPECTED);
  });
  it("aligns on the key columns: A order first, then B-only rows; delta only when both are numbers", () => {
    const al = alignCompare(A, B);
    expect(al.columns).toEqual(cols);
    expect(al.rows.map((r) => r.key)).toEqual([
      { scenarioId: "S0", familyId: "" },
      { scenarioId: "S0", familyId: "dda" },
      { scenarioId: "S100", familyId: "" },
      { scenarioId: "S200", familyId: "" },
    ]);
    expect(al.rows[0]!.delta).toEqual({ net12: 2.25 });
    expect(al.rows[1]!.delta).toEqual({ net12: null });
    expect(al.rows[2]!.b).toBeNull();
    expect(al.rows[3]!.a).toBeNull();
  });
});

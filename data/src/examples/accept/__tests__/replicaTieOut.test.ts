/**
 * The replica tie-out check fails on every edit of its targets that would drop coverage (S3a-2 fix round, M1).
 *
 * The review showed that a deleted target key, a deleted family, a dropped scenario and an added exclusion list all
 * passed, because the check walked the targets file instead of the engine. Each edit below is made on a copy of the
 * committed Quillfield targets, the engine having run once, and the line that covers the edited measure must fail.
 * The unedited targets pass, so the failures are the edits'.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMarketSnapshot } from "@alm/kernel";
import { compareSubject, QUILLFIELD, runEngine, type EngineRuns, type Targets } from "../replicaTieOut";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

let runs: EngineRuns;
let committed: string;
beforeAll(async () => {
  const market = await loadMarketSnapshot(resolve(REPO_ROOT, "packages/kernel/public/market_public.json"));
  runs = runEngine(REPO_ROOT, market, QUILLFIELD);
  committed = readFileSync(resolve(REPO_ROOT, QUILLFIELD.targetsPath), "utf8");
}, 120_000);

const fresh = (): Targets => JSON.parse(committed) as Targets;
const statusOf = (t: Targets): Record<string, string> => Object.fromEntries(compareSubject(QUILLFIELD, t, runs).map((l) => [l.id, l.status]));

describe("python-replica-tie-out refuses targets that lose coverage", () => {
  it("passes on the committed targets", () => {
    const s = statusOf(fresh());
    expect(Object.values(s).every((x) => x === "pass"), JSON.stringify(s)).toBe(true);
  });

  it("fails when one key is deleted (risk-free EVE at +200 bp)", () => {
    const t = fresh();
    delete (t.eve["risk-free"]!["S200"] as Record<string, unknown>).eve;
    expect(statusOf(t)["eve-risk-free"]).toBe("fail");
  });

  it("fails when a scenario total is deleted (NII 24 months at -100 bp)", () => {
    const t = fresh();
    delete (t.nii["S-100"] as Record<string, unknown>).totalNet24;
    expect(statusOf(t).nii).toBe("fail");
  });

  it("fails when a whole family is deleted (NII, EVE and FTP)", () => {
    const t = fresh();
    delete t.nii["S0"]!.byFamily["mb-mma"];
    delete t.eve["all-in"]!["S0"]!.byFamily["mb-cds"];
    delete t.ftp.byFamily["mb-heloc"];
    const s = statusOf(t);
    expect([s.nii, s["eve-all-in"], s.ftp]).toEqual(["fail", "fail", "fail"]);
  });

  it("fails when an FTP monthly series or a book cell is deleted", () => {
    const t = fresh();
    delete t.ftp.byFamily["mb-cre-fixed"]!.monthly.ftpAccrual;
    expect(statusOf(t).ftp).toBe("fail");
    const u = fresh();
    delete u.ftp.book.charges12;
    expect(statusOf(u).ftp).toBe("fail");
  });

  it("fails when a scenario is dropped from the targets", () => {
    const t = fresh();
    t.scenarios = t.scenarios.filter((s) => s.id !== "S-200");
    delete t.positions["S-200"];
    delete t.nii["S-200"];
    delete t.eve["risk-free"]!["S-200"];
    delete t.eve["all-in"]!["S-200"];
    delete t.gap.repricing["S-200"];
    delete t.gap.liquidity["S-200"];
    const s = statusOf(t);
    for (const id of ["scenarios", "positions", "nii", "eve-risk-free", "eve-all-in", "gap-repricing", "gap-liquidity"]) expect(s[id], id).toBe("fail");
  });

  it("fails when an exclusion list is added, whatever it names", () => {
    const t = fresh();
    t.ftp.excluded = { families: ["mb-savings"], cells: [] };
    delete t.ftp.byFamily["mb-savings"];
    const s = statusOf(t);
    expect(s.scenarios).toBe("fail");
    expect(s.ftp).toBe("fail");
  });

  it("fails on a target cell that is not a finite number, and on a position the engine does not hold", () => {
    const t = fresh();
    (t.eve["all-in"]!["S100"]!.byFamily as Record<string, unknown>)["mb-savings"] = null;
    expect(statusOf(t)["eve-all-in"]).toBe("fail");
    const u = fresh();
    u.positions["S0"]!["no-such-position"] = { balance: [1], principal: [], interest: [] };
    expect(statusOf(u).positions).toBe("fail");
  });
});

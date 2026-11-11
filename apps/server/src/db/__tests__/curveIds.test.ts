// apps/server/src/db/__tests__/curveIds.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openPlatformDb, type PlatformDb } from "../database";
import { CURVE_NAMES } from "../queries";
import { DB_SCHEMA_VERSION } from "../schema";

const root = mkdtempSync(join(tmpdir(), "alm-curve-ids-"));
let db: PlatformDb | undefined;

afterAll(() => {
  db?.close();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // The OS temp cleaner owns the leftovers.
  }
});

const insert = (curve: string) =>
  db!.db
    .prepare(
      `INSERT INTO curve_points (market_id, as_of, curve, seq, term, t_years, instrument_type, value)
       VALUES ('m', '2026-03-31', ?, 0, '1Y', 1, NULL, 0.04)`,
    )
    .run(curve);

describe("market curve ids (id-rename, schema 1.3.0)", () => {
  it("names the risk-free, term-funding and tlp curves", () => {
    expect(DB_SCHEMA_VERSION).toBe("1.3.0");
    expect([...CURVE_NAMES]).toEqual(["risk-free", "term-funding", "tlp"]);
  });

  it("accepts the new ids and refuses the retired ones", () => {
    db = openPlatformDb(join(root, "platform.db"));
    expect(() => insert("risk-free")).not.toThrow();
    expect(() => insert("term-funding")).not.toThrow();
    expect(() => insert("sofr-ois")).toThrow(/CHECK constraint failed/);
    expect(() => insert("fhlb")).toThrow(/CHECK constraint failed/);
  });
});

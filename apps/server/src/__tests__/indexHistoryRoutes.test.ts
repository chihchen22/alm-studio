// apps/server/src/__tests__/indexHistoryRoutes.test.ts
// The index-histories collection, its import route and its read route (decision 50).
// Paths, statuses and sentences are restated by hand from the spec; synthetic files only (decision 56).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexHistoryIdOf, type IndexHistory } from "@alm/engine";
import { FileStore } from "../store/store";
import { bootTestPlatform, type TestPlatform } from "./harness";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
}, 120_000);
afterAll(() => t.close());

/** Synthetic daily SOFR-style fixings in percent: 31 Jan and 28 Feb 2026 are Saturdays; 16 Feb is a holiday row. */
const DAILY = [
  "date,rate", "2026-01-29,4.30", "2026-01-30,4.31", "2026-02-02,4.32", "2026-02-16,.", "2026-02-26,4.33", "2026-02-27,4.34", "2026-03-02,4.35", "2026-03-31,4.36", "",
].join("\r\n");

interface Imported { id: string; created: boolean; history: IndexHistory }
interface Refused { error: { code: string; message: string; detail: { refusals: string[] } }; refusals: string[] }

async function post(query: string, body: Buffer, filename: string | null = "sofr-daily.csv"): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/octet-stream" };
  if (filename !== null) headers["X-Filename"] = filename;
  const res = await fetch(`${t.base}/api/index-histories/import${query}`, { method: "POST", headers, body: new Uint8Array(body) });
  return { status: res.status, body: (await res.json()) as unknown };
}

describe("index history routes (Piece B, step B3b, decision 50)", () => {
  let first: Imported;

  it("the first import answers 201 with the content-hash id, and the store holds the document under it", async () => {
    const r = await post("?unit=percent", Buffer.from(DAILY));
    expect(r.status).toBe(201);
    first = r.body as Imported;
    expect(first.created).toBe(true);
    expect(first.id).toMatch(/^ih-[0-9a-f]{16}$/);
    expect(first.id).toBe(indexHistoryIdOf(first.history));
    expect([first.history.label, first.history.firstMonth, first.history.values]).toEqual(["sofr-daily", "2026-01", [0.0431, 0.0434, 0.0436]]);
    const stored = new FileStore(t.storeRoot).getDocument<IndexHistory>("index-histories", first.id);
    expect(stored.doc).toEqual(first.history);
    expect(stored.meta.label).toBe("sofr-daily");
  });

  it("the same bytes again answer 200 created false with the same id; the collection does not grow", async () => {
    const before = new FileStore(t.storeRoot).listMeta("index-histories").length;
    const r = await post("?unit=percent", Buffer.from(DAILY));
    expect(r.status).toBe(200);
    const again = r.body as Imported;
    expect([again.id, again.created]).toEqual([first.id, false]);
    expect(again.history).toEqual(first.history);
    expect(new FileStore(t.storeRoot).listMeta("index-histories").length).toBe(before);
    expect(before).toBe(1);
  });

  it("a daily file that ends mid-month answers partialLastMonth beside the history, which is stored as parsed (B3b follow-up item 6)", async () => {
    const r = await post("?unit=percent", Buffer.from("date,rate\n2026-03-02,4.35\n2026-03-13,4.40\n"), "mid-month.csv");
    expect(r.status).toBe(201);
    const body = r.body as Imported & { partialLastMonth?: unknown };
    expect(body.partialLastMonth).toEqual({ month: "2026-03", lastDay: "2026-03-13" });
    expect(new FileStore(t.storeRoot).getDocument<IndexHistory>("index-histories", body.id).doc).toEqual(body.history);
    expect(body.id).toBe(indexHistoryIdOf(body.history));
    // The same bytes again answer 200 created false and still carry the flag, computed from the bytes (fix round 1, MINOR 1).
    const again = await post("?unit=percent", Buffer.from("date,rate\n2026-03-02,4.35\n2026-03-13,4.40\n"), "mid-month.csv");
    expect(again.status).toBe(200);
    const againBody = again.body as Imported & { partialLastMonth?: unknown };
    expect([againBody.id, againBody.created, againBody.partialLastMonth]).toEqual([body.id, false, { month: "2026-03", lastDay: "2026-03-13" }]);
    // A file that reaches its month end answers no flag.
    const full = await post("?unit=percent", Buffer.from(DAILY));
    expect("partialLastMonth" in (full.body as object)).toBe(false);
  });

  it("GET answers the stored document; an unknown id answers 404", async () => {
    const got = await fetch(`${t.base}/api/index-histories/${first.id}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(first.history);
    const missing = await fetch(`${t.base}/api/index-histories/ih-0000000000000000`);
    expect(missing.status).toBe(404);
  });

  it("refusals answer 422 with the sentences; a missing X-Filename answers 400; nothing is stored", async () => {
    const count = () => new FileStore(t.storeRoot).listMeta("index-histories").length;
    const before = count();
    const decimal = await post("?unit=decimal", Buffer.from(DAILY));
    expect(decimal.status).toBe(422);
    const body = decimal.body as Refused;
    expect(body.refusals[0]).toBe("row 2: value 4.3 is above 1.0, which a decimal rate cannot be; if the file is in percent, import it with the unit percent");
    expect(body.error.code).toBe("validation");
    expect(body.error.detail.refusals).toEqual(body.refusals);
    expect(body.error.message).toBe(body.refusals.join("; "));

    const noUnit = await post("", Buffer.from(DAILY));
    expect([noUnit.status, (noUnit.body as Refused).refusals]).toEqual([422, ["unit must be percent or decimal; the import never guesses the unit of a file"]]);

    const txt = await post("?unit=percent", Buffer.from(DAILY), "x.txt");
    expect([txt.status, (txt.body as Refused).refusals]).toEqual([422, ['file "x.txt" is neither .csv nor .xlsx']]);

    const big = await post("?unit=percent", Buffer.alloc(4_194_305, 0x20), "big.csv");
    expect([big.status, (big.body as Refused).refusals]).toEqual([422, ['file "big.csv" is 4194305 bytes; an index history file is at most 4194304 bytes']]);

    const noName = await post("?unit=percent", Buffer.from(DAILY), null);
    expect(noName.status).toBe(400);
    expect(count()).toBe(before);
  });

  it("a label sent on the query is trimmed and taken", async () => {
    const r = await post(`?unit=percent&label=${encodeURIComponent("  One-month (synthetic) ")}`, Buffer.from("2026-01,4.31\n2026-02,4.34\n"), "m.csv");
    expect(r.status).toBe(201);
    const got = r.body as Imported;
    expect(got.history.label).toBe("One-month (synthetic)");
    expect(new FileStore(t.storeRoot).getMeta("index-histories", got.id).label).toBe("One-month (synthetic)");
  });
});

/**
 * The replica's input notice, replica/inputs/NOTICE, carries the SOFR terms the shipped SOFR
 * history carries. examples/sofr-monthly-v1.json holds the notice the New York Fed's terms ask for in its `notice`
 * field, with its source, source address, retrieval date and terms address; three replica input files embed copies of
 * those values and carry no notice field of their own, so the folder's NOTICE says it for them. This test holds the
 * NOTICE to the JSON field by field, so an edit to one cannot leave the other behind, and holds its file list to the
 * files that exist.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NOTICE = readFileSync(resolve(REPO, "replica/inputs/NOTICE"), "utf8");
const SOFR = JSON.parse(readFileSync(resolve(REPO, "examples/sofr-monthly-v1.json"), "utf8")) as Record<string, unknown>;
/** The NOTICE with its line wrapping undone, so a field reads the same however the file wraps it. */
const flat = NOTICE.replace(/\s+/g, " ");

describe("replica/inputs/NOTICE and the SOFR history's notice", () => {
  it("carries the JSON's notice field verbatim", () => {
    expect(typeof SOFR.notice).toBe("string");
    expect((SOFR.notice as string).length).toBeGreaterThan(100);
    expect(flat).toContain(SOFR.notice as string);
  });

  it("carries the JSON's source, source address, retrieval date and terms address", () => {
    expect(flat).toContain(`Source: ${SOFR.source as string}: ${SOFR.sourceUrl as string}. Retrieved ${SOFR.retrieved as string}.`);
    expect(flat).toContain(`Terms of Use: ${SOFR.termsUrl as string}`);
  });

  it("names replica input files that exist, each embedding SOFR values and carrying no notice field of its own", () => {
    const listed = [...NOTICE.matchAll(/^\s+(replica\/inputs\/\S+\.json)\s*$/gm)].map((m) => m[1]);
    expect(listed).toEqual(["replica/inputs/deposit-forms-v1.json", "replica/inputs/feature-demos-v1.json", "replica/inputs/survival-path-v1.json"]);
    const first = (SOFR.valuesPct as number[]).slice(0, 3).map(String);
    for (const p of listed) {
      expect(existsSync(resolve(REPO, p)), p).toBe(true);
      const text = readFileSync(resolve(REPO, p), "utf8");
      expect(text.includes(`"${"notice"}"`), `${p} has no notice field`).toBe(false);
      expect(first.every((v) => text.includes(v)), `${p} embeds the SOFR values`).toBe(true);
    }
  });
});

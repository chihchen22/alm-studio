// The id-rename golden differs from the frozen per-position WAC golden in
// exactly two strings, the FTP basis labels, and in no number.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./golden/${name}`, import.meta.url)), "utf8"));

describe("id-rename golden", () => {
  it("equals demo-run.position-wac.json once the two FTP basis labels are restored", () => {
    const frozen = read("demo-run.position-wac.json");
    const live = read("demo-run.id-rename.json");
    expect(live.ftp.irBasis).toBe("risk-free");
    expect(live.ftp.allInBasis).toBe("risk-free-plus-tlp");
    live.ftp.irBasis = "sofr";
    live.ftp.allInBasis = "sofr-plus-tlp";
    expect(JSON.stringify(live)).toBe(JSON.stringify(frozen));
  });
});

/**
 * One placeholder constant (ALM Studio Polish 5 T4). The top bar prints "none" on a select pill with nothing selected, and SelectPill marks that pill
 * pill-none so the word never shrinks (Polish 4 Task 5 fix I1). One exported constant holds the word; SelectPill
 * compares against it and, since Piece E2 retired the four context pills, the top bar's context button prints it
 * when no workspace is open, so a rename on one side cannot turn pill-none off. The word and the source texts are
 * restated here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PILL_NONE } from "../shell/SelectPill";

const BAR = readFileSync(new URL("../shell/TopBar.tsx", import.meta.url), "utf8");
const PILL = readFileSync(new URL("../shell/SelectPill.tsx", import.meta.url), "utf8");

describe("the top bar's placeholder", () => {
  it("is one exported constant holding the word none", () => {
    expect(PILL_NONE).toBe("none");
    expect(PILL).toContain('export const PILL_NONE = "none";');
    expect(PILL.match(/"none"/g)).toEqual(['"none"']);
  });
  it("is what SelectPill compares against", () => {
    expect(PILL).toContain("props.value === PILL_NONE");
  });
  it("is what the top bar prints when no workspace is open, with no bare word left", () => {
    // The bare word as a value (the sheet's close icon sets fill to none, which is CSS, not a label).
    expect(BAR).not.toMatch(/[?:]\s*"none"/);
    expect(BAR).toMatch(/import \{[^}]*\bPILL_NONE\b[^}]*\} from "\.\/SelectPill";/);
    expect(BAR.match(/\bPILL_NONE\b/g)).toHaveLength(2);
  });
});

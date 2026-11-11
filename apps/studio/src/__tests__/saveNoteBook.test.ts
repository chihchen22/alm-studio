/**
 * The save note clears on a Book change (ALM Studio Polish 3 T4, Minor 1 and Polish 2 spec A1). Effects do not run
 * under renderToStaticMarkup, so this pins the page's one effect by its source line; noteShown's own rule is pinned
 * in polish2Edits.test.ts, and the drive walks Book b1 to b2 to b1 on the live page. The line is restated here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PAGE = readFileSync(new URL("../pages/assumptions/EditSetPage.tsx", import.meta.url), "utf8");

describe("the save note on a Book change", () => {
  it("is dropped by the page whenever the Book pill changes, so a return to its book does not bring it back", () => {
    expect(PAGE).toContain("useEffect(() => { setNote(null); }, [props.bookId]);");
  });
});

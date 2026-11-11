// packages/reader/src/__tests__/workspacesTypesDiff.test.ts
// Studio A+E Slice 1, Task D3: the reader cannot import the server, so its workspace types are
// copies. This test diffs each copy against its server source, declaration by declaration and
// comments included, so a server edit that is not mirrored (or the reverse) fails here and does not
// drift. It is the executable form of the plan's review-point diff of WorkspaceManifest.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), "utf8");

const READER = read("../api/workspaces.ts");
const SERVER = {
  "workspaces/types.ts": read("../../../../apps/server/src/workspaces/types.ts"),
  "workspaces/readiness.ts": read("../../../../apps/server/src/workspaces/readiness.ts"),
  "workspaces/hashes.ts": read("../../../../apps/server/src/workspaces/hashes.ts"),
  "store/paths.ts": read("../../../../apps/server/src/store/paths.ts"),
  "http/routes/workspaceCompare.ts": read("../../../../apps/server/src/http/routes/workspaceCompare.ts"),
} as const;

/** The reader renames the compare types (client.ts already owns CompareReply); undo that before comparing. */
function toServerNames(text: string): string {
  return text
    .replace(/\bWorkspaceCompareTuple\b/g, "Tuple")
    .replace(/\bWorkspaceCompare(Verdict|Block|Side|Reply)\b/g, "Compare$1");
}

const STARTS = /^export (interface|type|const) ([A-Za-z0-9_]+)/;

/** The declaration of `name` with the doc or line comment block directly above it, trailing blanks trimmed. */
function declarationOf(source: string, name: string, withComment: boolean): string | null {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => {
    const m = STARTS.exec(l);
    return m !== null && m[2] === name;
  });
  if (start < 0) return null;
  // End of the declaration.
  const kind = STARTS.exec(lines[start]!)![1];
  let end = start;
  if (kind === "interface") {
    while (lines[end] !== "}") end++;
  } else {
    let depth = 0;
    for (end = start; end < lines.length; end++) {
      const code = lines[end]!.replace(/\s*\/\/.*$/, "");
      for (const ch of code) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth === 0 && code.endsWith(";")) break;
    }
  }
  // The comment block directly above (no blank line between).
  let from = start;
  if (withComment) {
    let k = start - 1;
    if (k >= 0 && lines[k]!.trimEnd().endsWith("*/")) {
      while (k >= 0 && !lines[k]!.trimStart().startsWith("/**")) k--;
      from = k;
    } else {
      while (k >= 0 && lines[k]!.trimStart().startsWith("//")) k--;
      from = k + 1;
    }
  }
  return lines.slice(from, end + 1).map((l) => l.trimEnd()).join("\n");
}

/** Names exported as interface, type or const between two banner titles of the reader file. */
function readerNamesIn(fromBanner: string, toBanner: string): string[] {
  const a = READER.indexOf(fromBanner);
  const b = READER.indexOf(toBanner);
  expect(a, `banner "${fromBanner}"`).toBeGreaterThanOrEqual(0);
  expect(b, `banner "${toBanner}"`).toBeGreaterThan(a);
  return READER.slice(a, b)
    .split("\n")
    .map((l) => STARTS.exec(l)?.[2])
    .filter((n): n is string => n !== undefined);
}

function exportedTypeNames(source: string): string[] {
  return source
    .split("\n")
    .map((l) => /^export (?:interface|type) ([A-Za-z0-9_]+)/.exec(l)?.[1])
    .filter((n): n is string => n !== undefined);
}

function assertCopied(readerName: string, serverFile: keyof typeof SERVER, withComment = true): void {
  const serverName = toServerNames(readerName);
  const copy = declarationOf(READER, readerName, withComment);
  const original = declarationOf(SERVER[serverFile], serverName, withComment);
  expect(original, `${serverName} is not declared in apps/server/src/${serverFile}`).not.toBeNull();
  expect(copy, `${readerName} is not declared in packages/reader/src/api/workspaces.ts`).not.toBeNull();
  expect(toServerNames(copy!), `${readerName} differs from apps/server/src/${serverFile}`).toBe(original);
}

describe("reader workspace types are verbatim copies of the server's", () => {
  it("every declaration copied from workspaces/types.ts matches its source text, comments included", () => {
    const names = readerNamesIn("// Copied from apps/server/src/workspaces/types.ts", "// Copied from apps/server/src/workspaces/readiness.ts");
    for (const n of names) assertCopied(n, "workspaces/types.ts");
    // A deleted copy must not pass as a smaller loop: the list is the server's whole export set.
    expect([...names].sort()).toEqual(exportedTypeNames(SERVER["workspaces/types.ts"]).sort());
    expect(names.length).toBeGreaterThanOrEqual(34);
  });

  it("the manifest, the block shapes and the history line are in that set, by name", () => {
    const names = readerNamesIn("// Copied from apps/server/src/workspaces/types.ts", "// Copied from apps/server/src/workspaces/readiness.ts");
    for (const n of ["WorkspaceManifest", "WorkspaceBlocks", "DocRef", "DerivedRef", "CarriedDefinition", "HistoryChange", "HistoryLine", "RunAttachment", "RunSetup", "SetupEvent", "ConsumedPins"]) {
      expect(names).toContain(n);
    }
  });

  it("the readiness shapes and the two acknowledgement ids match readiness.ts", () => {
    const names = readerNamesIn("// Copied from apps/server/src/workspaces/readiness.ts", "// Copied from apps/server/src/http/routes/workspaceCompare.ts");
    expect(names).toEqual(["ReadinessState", "SectionId", "StaleRole", "ReadinessItem", "ReadinessReport"]);
    for (const n of names) assertCopied(n, "workspaces/readiness.ts");
    for (const c of ["RUN_SETUPS_ITEM", "RUN_SETUP_WARNINGS_ITEM"]) {
      expect(declarationOf(READER, c, false)).toBe(declarationOf(SERVER["workspaces/readiness.ts"], c, false));
    }
  });

  it("the Collection union matches paths.ts", () => {
    // The server's comment is a store-layout essay; the union itself is the contract.
    assertCopied("Collection", "store/paths.ts", false);
  });

  it("the compare reply matches workspaceCompare.ts once the Workspace prefix is undone", () => {
    for (const n of ["WorkspaceCompareVerdict", "WorkspaceCompareBlock", "WorkspaceCompareSide", "WorkspaceCompareReply"]) {
      assertCopied(n, "http/routes/workspaceCompare.ts");
    }
    assertCopied("WorkspaceCompareTuple", "workspaces/hashes.ts");
  });

  it("the WorkspaceManifest block is byte-identical, which is the plan's review-point diff", () => {
    const a = declarationOf(SERVER["workspaces/types.ts"], "WorkspaceManifest", true);
    const b = declarationOf(READER, "WorkspaceManifest", true);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });

  it("the extractor itself sees a changed field (a guard against a test that cannot fail)", () => {
    const mutated = READER.replace("  revision: number;\n  blocks: WorkspaceBlocks;", "  revision: string;\n  blocks: WorkspaceBlocks;");
    expect(mutated).not.toBe(READER);
    expect(declarationOf(mutated, "WorkspaceManifest", true)).not.toBe(declarationOf(SERVER["workspaces/types.ts"], "WorkspaceManifest", true));
  });
});

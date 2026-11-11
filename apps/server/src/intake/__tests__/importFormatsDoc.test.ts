/**
 * Doc-sync gate: the CSV column table in docs/import-formats.md
 * must equal the contract generated from the kernel sources. If the kernel's
 * term interfaces move, this test fails until the doc's generated region is
 * regenerated, so the published contract can never drift from the source.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderColumnContractMarkdown } from "../columnContract";

const DOC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../docs/import-formats.md",
);

const BEGIN = "<!-- BEGIN GENERATED: csv-column-contract -->";
const END = "<!-- END GENERATED: csv-column-contract -->";

describe("import-formats.md", () => {
  it("carries the generated CSV column contract, byte for byte", () => {
    const doc = readFileSync(DOC_PATH, "utf-8");
    const begin = doc.indexOf(BEGIN);
    const end = doc.indexOf(END);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    const embedded = doc.slice(begin + BEGIN.length, end).trim();
    expect(embedded).toBe(renderColumnContractMarkdown().trim());
  });
});

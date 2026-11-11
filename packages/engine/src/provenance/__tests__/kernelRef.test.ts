import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { parseKernelProvenanceRef, readKernelProvenanceRef } from "../kernelRef";
import { isPublicExport, SOURCE_KERNEL_ID } from "../publicCopy";

const here = dirname(fileURLToPath(import.meta.url));
// src/provenance/__tests__ -> packages/kernel/PROVENANCE.md
const kernelProvenancePath = resolve(here, "..", "..", "..", "..", "kernel", "PROVENANCE.md");
const repoRoot = resolve(here, "..", "..", "..", "..", "..");

/** A placeholder commit id: forty hex digits that name no commit. */
const SAMPLE_COMMIT = "c".repeat(40);
const SAMPLE = [
  "# @alm/kernel — Provenance",
  "",
  `- **Source git commit:** \`${SAMPLE_COMMIT}\``,
  "- **Copy date:** 2026-07-16",
  "",
].join("\n");

describe("parseKernelProvenanceRef", () => {
  it("extracts the source commit from the markdown", () => {
    expect(parseKernelProvenanceRef(SAMPLE).sourceCommit).toBe(SAMPLE_COMMIT);
  });

  it("hashes the full markdown text to a 64-char lowercase hex digest", () => {
    expect(parseKernelProvenanceRef(SAMPLE).provenanceFileHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the file hash when the text changes but not the extracted commit", () => {
    const edited = SAMPLE + "extra line\n";
    const a = parseKernelProvenanceRef(SAMPLE);
    const b = parseKernelProvenanceRef(edited);
    expect(b.provenanceFileHash).not.toBe(a.provenanceFileHash);
    expect(b.sourceCommit).toBe(a.sourceCommit);
  });

  it("throws when no source commit line is present", () => {
    expect(() => parseKernelProvenanceRef("# no commit here")).toThrow(/commit/i);
  });
});

describe("readKernelProvenanceRef — against the real vendored manifest", () => {
  it("reads the actual kernel PROVENANCE.md and recovers the vendored commit", () => {
    const ref = readKernelProvenanceRef(kernelProvenancePath);
    // A full record names its source commit; a release tree's record names its own kernel id instead.
    if (!isPublicExport(repoRoot)) expect(ref.sourceCommit).toBe(SOURCE_KERNEL_ID);
    else expect(ref.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(ref.provenanceFileHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic across repeated reads", () => {
    expect(readKernelProvenanceRef(kernelProvenancePath)).toEqual(readKernelProvenanceRef(kernelProvenancePath));
  });
});

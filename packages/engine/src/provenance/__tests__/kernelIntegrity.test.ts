/**
 * Kernel integrity hash gate, standing suite member.
 *
 * Reads packages/kernel/PROVENANCE.md, re-hashes every file the manifest lists
 * (100 kernel math files + 2 public data fixtures = 102 rows), and asserts zero
 * mismatches. A mismatch means the frozen kernel was edited, a
 * fixture drifted, or the manifest was tampered with.
 *
 * BYTE CONTRACT: the recorded hashes are lowercase SHA-256 over the macOS
 * working-tree bytes that the vendor tool
 * copied from the Lab on 2026-09-24. This test hashes the raw on-disk bytes
 * with NO normalization, because the manifest's claim is byte-for-byte
 * identity against those bytes. The CRLF diagnostic below stays as a
 * diagnostic: on a raw-byte mismatch of a CR-free text file, the failure
 * message also reports whether the LF->CRLF re-expansion of the bytes
 * reproduces the recorded hash, so a line-ending-only drift is distinguishable
 * from a content edit. The diagnostic never converts a mismatch into a pass;
 * the pass criterion is raw bytes, full stop.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { absenceAllowed, expectedKernelRows, isPublicExport, SOURCE_KERNEL_ID, SOURCE_KERNEL_PROVENANCE_SHA256 } from "../publicCopy";

const here = dirname(fileURLToPath(import.meta.url));
// src/provenance/__tests__ -> packages/kernel
const kernelRoot = resolve(here, "..", "..", "..", "..", "kernel");
const provenancePath = resolve(kernelRoot, "PROVENANCE.md");
const repoRoot = resolve(kernelRoot, "..", "..");

// 102 = 100 math files + 2 public data files in a full record; a release tree lists only the files it holds.
const { total: EXPECTED_TOTAL_ROWS, math: EXPECTED_MATH_ROWS, fixtures: EXPECTED_FIXTURE_ROWS } = expectedKernelRows(repoRoot);

interface ManifestRow {
  /** Path relative to packages/kernel/, forward slashes as recorded. */
  file: string;
  /** Recorded SHA-256 hex, compared lowercase. */
  sha256: string;
}

/**
 * Extract every hash row from the manifest text. A hash row is a markdown
 * table row whose second cell is exactly 64 hex characters; the manifest's
 * other tables (runtime dependencies, excluded files) never match that shape,
 * so this selects precisely the 100 math rows + 2 fixture rows.
 */
function parseManifestRows(markdown: string): ManifestRow[] {
  const rowRe = /^\|\s*(\S+)\s*\|\s*([0-9a-fA-F]{64})\s*\|\s*$/gm;
  const rows: ManifestRow[] = [];
  for (let m = rowRe.exec(markdown); m !== null; m = rowRe.exec(markdown)) {
    rows.push({ file: m[1], sha256: m[2] });
  }
  return rows;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const manifestText = readFileSync(provenancePath, "utf8");
const rows = parseManifestRows(manifestText);

describe("kernel integrity gate: PROVENANCE.md vs disk (raw working-tree bytes, no normalization)", () => {
  it(`manifest lists exactly ${EXPECTED_TOTAL_ROWS} hash rows: ${EXPECTED_MATH_ROWS} math files + 2 public data fixtures, no duplicates`, () => {
    expect(rows).toHaveLength(EXPECTED_TOTAL_ROWS);

    const mathRows = rows.filter((r) => r.file.startsWith("src/math/"));
    const fixtureRows = rows.filter((r) => !r.file.startsWith("src/math/"));
    expect(mathRows).toHaveLength(EXPECTED_MATH_ROWS);
    expect(fixtureRows).toHaveLength(EXPECTED_FIXTURE_ROWS);
    expect(fixtureRows.map((r) => r.file).sort()).toEqual([
      "public/market_public.json",
      "public/rate_history_public.json",
    ]);

    const unique = new Set(rows.map((r) => r.file));
    expect(unique.size).toBe(EXPECTED_TOTAL_ROWS);
  });

  it(`re-hashes all ${EXPECTED_TOTAL_ROWS} listed files from disk with 0 mismatches (raw bytes, no line-ending normalization)`, () => {
    expect(rows).toHaveLength(EXPECTED_TOTAL_ROWS); // do not let a gutted manifest pass vacuously

    const mismatches: string[] = [];
    for (const row of rows) {
      const expected = row.sha256.toLowerCase();
      const absPath = resolve(kernelRoot, ...row.file.split("/"));
      let bytes: Buffer;
      try {
        bytes = readFileSync(absPath);
      } catch {
        // A file a release tree does not ship may be absent in a release tree only; any other absence fails.
        if (absenceAllowed(repoRoot, row.file)) continue;
        mismatches.push(`${row.file}: MISSING from disk (expected ${expected})`);
        continue;
      }
      const actual = sha256Hex(bytes);
      if (actual === expected) continue;

      // Diagnostic only, never a pass path. If the on-disk file carries no CR
      // bytes, check whether re-expanding LF to CRLF reproduces the recorded
      // hash, which pins the drift to line endings rather than a content edit.
      let diagnosis = "content differs from the recorded working-tree bytes";
      if (!bytes.includes(0x0d)) {
        const crlfHash = sha256Hex(Buffer.from(bytes.toString("latin1").replace(/\n/g, "\r\n"), "latin1"));
        diagnosis =
          crlfHash === expected
            ? "line-ending-only drift: file is LF on disk but the manifest recorded CRLF bytes; content is identical modulo CR"
            : "content differs (and the difference is not explained by LF vs CRLF)";
      }
      mismatches.push(`${row.file}: expected ${expected}, got ${actual}: ${diagnosis}`);
    }

    expect(mismatches, `kernel integrity violations:\n${mismatches.join("\n")}`).toEqual([]);
  });

  it("allows a kernel file's absence only in a release tree, and only for a file it does not ship", () => {
    // Without the release marker no recorded file may be absent.
    if (!isPublicExport(repoRoot)) {
      expect(absenceAllowed(repoRoot, "src/math/behavioral/comparisonGate.ts")).toBe(false);
      expect(rows.some((r) => r.file === "src/math/behavioral/comparisonGate.ts")).toBe(true);
      expect([EXPECTED_TOTAL_ROWS, EXPECTED_MATH_ROWS, EXPECTED_FIXTURE_ROWS]).toEqual([102, 100, 2]);
      // The record hash the pinned whole-result tests use (withSourceKernelRef) is this record's.
      expect(sha256Hex(Buffer.from(manifestText, "utf8"))).toBe(SOURCE_KERNEL_PROVENANCE_SHA256);
      expect(/Source git commit:\*\*\s*`([0-9a-f]{40})`/.exec(manifestText)?.[1]).toBe(SOURCE_KERNEL_ID);
    } else {
      // A release tree's record lists what it holds: a file it does not ship is no row.
      expect(rows.some((r) => r.file === "src/math/behavioral/comparisonGate.ts")).toBe(false);
      expect(rows.some((r) => r.file === "src/math/behavioral/__tests__/clientRateModel.test.ts")).toBe(false);
      expect([EXPECTED_TOTAL_ROWS, EXPECTED_MATH_ROWS, EXPECTED_FIXTURE_ROWS]).toEqual([100, 98, 2]);
    }
    // Only the named file is ever allowed, even in an export.
    expect(absenceAllowed(repoRoot, "src/math/behavioral/nmdModel.ts")).toBe(false);
  });
});

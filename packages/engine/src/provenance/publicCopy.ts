/**
 * The kernel provenance record's rules for a release tree. A release tree holds the marker file
 * `PUBLIC_EXPORT_MARKER` and no optional extension folder; its kernel record lists only the kernel files the tree
 * holds. Absent is allowed for the files in `KERNEL_FILES_DROPPED_IN_PUBLIC_COPY` only, and only in such a tree; any
 * other tree must hold every recorded kernel file, and a present file is always hashed like every other row.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Kernel files a release tree does not ship. */
export const KERNEL_FILES_DROPPED_IN_PUBLIC_COPY: readonly string[] = Object.freeze([
  "src/math/behavioral/comparisonGate.ts",
  "src/math/behavioral/__tests__/clientRateModel.test.ts",
]);

/** The marker file at the root of a release tree. */
export const PUBLIC_EXPORT_MARKER = ".alm-public-export";

/** True only in a release tree: the marker is there and the optional extension folder is not. */
export function isPublicExport(repoRoot: string): boolean {
  return existsSync(join(repoRoot, PUBLIC_EXPORT_MARKER)) && !existsSync(join(repoRoot, "companion"));
}

/** A recorded kernel file whose absence a gate may accept: one a release tree does not ship, in a release tree. */
export function absenceAllowed(repoRoot: string, kernelFile: string): boolean {
  return isPublicExport(repoRoot) && KERNEL_FILES_DROPPED_IN_PUBLIC_COPY.includes(kernelFile);
}

/**
 * The kernel reference the pinned whole-result hashes were recorded against: the SHA-256 of a kernel provenance
 * record, which every run stamps as `provenance.kernel.provenanceFileHash` (kernelRef.ts), and a kernel id, stamped
 * as `provenance.kernel.sourceCommit`. A release tree carries its own record and id, so its runs stamp other values.
 */
export const SOURCE_KERNEL_PROVENANCE_SHA256 = "bc57d2e0b8f92e16c37edc4ab6cd39fcd33488f4a663cab2f13f7e48f95b203d";
export const SOURCE_KERNEL_ID = "0000000000000000000000000000000000000000"; // a release tree withholds the source's id

const ENGINE_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * For a test that pins the hash of a whole result: the result with the kernel reference the pin was recorded with.
 * Outside a release tree the identity, so the pin proves every byte. In a release tree the two fields that differ,
 * the kernel record's hash and the kernel id, are set to those values, so the pin proves every other byte; the
 * tree's own record is held by the kernel integrity gate and the acceptance battery's kernel-ref check.
 */
export function withSourceKernelRef<T>(result: T, repoRoot: string = ENGINE_REPO_ROOT): T {
  const r = result as unknown as { provenance?: { kernel?: { provenanceFileHash?: string; sourceCommit?: string } } };
  if (!isPublicExport(repoRoot) || r.provenance?.kernel?.provenanceFileHash === undefined) return result;
  const kernel = { ...r.provenance.kernel, provenanceFileHash: SOURCE_KERNEL_PROVENANCE_SHA256 };
  if (kernel.sourceCommit !== undefined) kernel.sourceCommit = SOURCE_KERNEL_ID;
  return { ...r, provenance: { ...r.provenance, kernel } } as unknown as T;
}

/** The kernel's math files and public data files in a full provenance record: 100 + 2 = 102 rows. */
export const KERNEL_MATH_ROWS = 100;
export const KERNEL_FIXTURE_ROWS = 2;

/**
 * The hash rows a kernel provenance record must list: 100 math files and 2 public data files, less the files a
 * release tree does not ship when this is one (98 + 2 = 100). The count is exact either way, so a gutted record
 * still fails.
 */
export function expectedKernelRows(repoRoot: string): { math: number; fixtures: number; total: number } {
  const math = KERNEL_MATH_ROWS - (isPublicExport(repoRoot) ? KERNEL_FILES_DROPPED_IN_PUBLIC_COPY.length : 0);
  return { math, fixtures: KERNEL_FIXTURE_ROWS, total: math + KERNEL_FIXTURE_ROWS };
}

/**
 * Kernel provenance reference. The engine records which vendored kernel produced
 * a run by carrying the source commit and a digest of packages/kernel/
 * PROVENANCE.md (the per-file hash manifest), not the full file list.
 *
 * The commit is extracted from the manifest text and the digest is a SHA-256 of
 * that same text, so the reference verifies the actual manifest rather than
 * trusting a hand-copied literal. Pure given its input: no clock, no randomness.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { KernelProvenanceRef } from "../contracts";

const COMMIT_RE = /(?:Source git commit|Kernel source id):\*\*\s*`([0-9a-fA-F]{7,40})`/;

/** Parse a KernelProvenanceRef from the text of a kernel PROVENANCE.md. */
export function parseKernelProvenanceRef(provenanceMarkdown: string): KernelProvenanceRef {
  const match = COMMIT_RE.exec(provenanceMarkdown);
  if (!match) {
    throw new Error("parseKernelProvenanceRef: source commit or kernel source id line not found in PROVENANCE.md text");
  }
  return {
    sourceCommit: match[1],
    provenanceFileHash: createHash("sha256").update(provenanceMarkdown).digest("hex"),
  };
}

/** Read a kernel PROVENANCE.md from disk and parse its reference. */
export function readKernelProvenanceRef(filePath: string): KernelProvenanceRef {
  return parseKernelProvenanceRef(readFileSync(filePath, "utf8"));
}

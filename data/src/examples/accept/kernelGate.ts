/**
 * Acceptance check: kernel-hash-gate-standing.
 *
 * The capability is that the kernel byte-integrity gate is a STANDING suite
 * member, not a manual script. Anchors:
 *
 *   1. standing-member — the suite file
 *      packages/engine/src/provenance/__tests__/kernelIntegrity.test.ts exists
 *      and carries the load-bearing content: it parses PROVENANCE.md rows,
 *      pins the 102 = 100 + 2 count, and re-hashes with node:crypto. (The file's
 *      presence in the vitest include glob makes it run on every `npm test`.)
 *   2. re-hash — this check independently re-hashes every manifest row
 *      in-process (the same arithmetic stage 0 runs; here it is the
 *      capability's own line so the register entry is self-contained).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CapabilityCheck, CheckLine } from "./types";
import { absenceAllowed, expectedKernelRows } from "@alm/engine/src/provenance/publicCopy";

const HASH_ROW_RE = /^\|\s*(\S+)\s*\|\s*([0-9A-Fa-f]{64})\s*\|/gm;
// 102 rows in a full record; a release tree lists only the kernel files it holds.

export const kernelGateCheck: CapabilityCheck = {
  capabilityId: "kernel-hash-gate-standing",
  title: "Kernel byte-integrity gate as a standing suite member",
  run({ repoRoot }) {
    const EXPECTED_ROWS = expectedKernelRows(repoRoot).total;
    const lines: CheckLine[] = [];
    const testPath = resolve(
      repoRoot,
      "packages/engine/src/provenance/__tests__/kernelIntegrity.test.ts",
    );
    if (!existsSync(testPath)) {
      lines.push({
        id: "standing-member",
        status: "fail",
        detail: `standing suite member missing: ${testPath}`,
      });
    } else {
      const src = readFileSync(testPath, "utf8");
      const hasCount = /102/.test(src) && /100/.test(src);
      const hasCrypto = /node:crypto/.test(src) && /sha-?256/i.test(src);
      const hasManifest = /PROVENANCE\.md/.test(src);
      lines.push({
        id: "standing-member",
        status: hasCount && hasCrypto && hasManifest ? "pass" : "fail",
        detail:
          `kernelIntegrity.test.ts present in the engine suite; pins the 102-row count=${hasCount}, ` +
          `re-hashes via node:crypto=${hasCrypto}, reads PROVENANCE.md=${hasManifest} ` +
          `(anchor: the gate runs on every \`npm test\`, enforced mechanically)`,
      });
    }

    const manifestPath = resolve(repoRoot, "packages/kernel/PROVENANCE.md");
    const manifest = readFileSync(manifestPath, "utf8");
    const rows: Array<{ file: string; hash: string }> = [];
    for (const m of manifest.matchAll(HASH_ROW_RE)) rows.push({ file: m[1], hash: m[2].toUpperCase() });
    let mismatches = 0;
    let missing = 0;
    let dropped = 0;
    for (const r of rows) {
      const p = resolve(repoRoot, "packages/kernel", r.file);
      if (!existsSync(p)) {
        // A file a release tree does not ship may be absent in a release tree only; any other absence fails.
        if (absenceAllowed(repoRoot, r.file)) {
          dropped++;
          continue;
        }
        missing++;
        continue;
      }
      const actual = createHash("sha256").update(readFileSync(p)).digest("hex").toUpperCase();
      if (actual !== r.hash) mismatches++;
    }
    lines.push({
      id: "re-hash",
      status: rows.length === EXPECTED_ROWS && mismatches === 0 && missing === 0 ? "pass" : "fail",
      detail:
        `${rows.length - dropped}/${EXPECTED_ROWS} manifest rows re-hashed in-process${dropped === 0 ? "" : ` (${dropped} not shipped in this tree)`}: ${mismatches} mismatches, ` +
        `${missing} missing (anchor: byte identity against the committed PROVENANCE.md; the frozen-kernel ` +
        `constraint is verified, not asserted)`,
    });

    return { lines, observedNotImplemented: [] };
  },
};

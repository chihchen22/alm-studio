/**
 * Test-only TLP fixture: the pre-2026-08-13 shipped default (the rounded
 * 9/30/2025 FHLB - SOFR spread schedule). Kept test-side so the hand-pinned
 * FTP arithmetic in the suite stays put after the shipped fallback moved to
 * the constructed illustrative schedule (ruling 2026-08-13, two-track
 * spec Section 5 lane). Nothing in the app may import this file: test files
 * are unreachable from the bundle entry and must stay that way.
 */
import { buildTLPCurve, type TLPCurve, type TLPNode } from "../tlpCurve";

export const LEGACY_TEST_TLP_NODES: ReadonlyArray<TLPNode> = [
  { tYears: 0, spread: 0.0 },
  { tYears: 1 / 12, spread: 0.0021 },
  { tYears: 3 / 12, spread: 0.0019 },
  { tYears: 6 / 12, spread: 0.0020 },
  { tYears: 1, spread: 0.0031 },
  { tYears: 2, spread: 0.0043 },
  { tYears: 3, spread: 0.0050 },
  { tYears: 4, spread: 0.0056 },
  { tYears: 5, spread: 0.0056 },
  { tYears: 10, spread: 0.0091 },
  { tYears: 20, spread: 0.0134 },
  { tYears: 30, spread: 0.0153 },
];

export const LEGACY_TEST_TLP_CURVE: TLPCurve = buildTLPCurve(LEGACY_TEST_TLP_NODES);

/**
 * Shipped snapshot / rate-history date alignment gate (ruling
 * 2026-08-14). FTP and the NMD regime calculations read the history at the
 * snapshot month; the bundled pair MUST agree, or every fresh load runs on a
 * silently stale history tail. The same contract is enforced at runtime for
 * user imports via `historyCoversMonth` (Import tab notice +
 * HistoryAlignmentNotice on the model tabs).
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { historyCoversMonth, parseRateHistory } from "../rateHistory";

const PUBLIC_DIR = resolve(__dirname, "..", "..", "..", "..", "public");

describe("shipped snapshot / history alignment", () => {
  it("market_public.json calibration month equals rate_history_public.json end month", async () => {
    const snap = JSON.parse(
      await readFile(resolve(PUBLIC_DIR, "market_public.json"), "utf-8"),
    ) as { calibration_date: string };
    const rawHistory = JSON.parse(
      await readFile(resolve(PUBLIC_DIR, "rate_history_public.json"), "utf-8"),
    ) as { end_month: string };

    expect(snap.calibration_date.slice(0, 7)).toBe(rawHistory.end_month);

    const history = parseRateHistory(rawHistory as never);
    expect(historyCoversMonth(history, snap.calibration_date)).toBe(true);
  });

  it("historyCoversMonth accepts covered months and rejects later ones", async () => {
    const raw = JSON.parse(
      await readFile(resolve(PUBLIC_DIR, "rate_history_public.json"), "utf-8"),
    ) as { end_month: string };
    const history = parseRateHistory(raw as never);
    expect(historyCoversMonth(history, "2026-03-31")).toBe(true);
    expect(historyCoversMonth(history, "2026-03")).toBe(true);
    expect(historyCoversMonth(history, "2026-06-30")).toBe(false);
    expect(historyCoversMonth(history, "2008-09")).toBe(false);
  });
});

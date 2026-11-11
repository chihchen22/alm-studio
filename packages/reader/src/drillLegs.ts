import type { InstrumentScenarioProjectionView, InstrumentScheduleRowView } from "./api/client";

export interface LegTable {
  leg: "receive" | "pay";
  rows: InstrumentScheduleRowView[];
}

/** A swap drill's two leg schedules, receive first, exactly as served; [] for anything else. */
export function legTables(p: InstrumentScenarioProjectionView): LegTable[] {
  if (p.legs === undefined) return [];
  return [
    { leg: "receive", rows: p.legs.receive },
    { leg: "pay", rows: p.legs.pay },
  ];
}

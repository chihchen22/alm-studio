// apps/studio/src/pages/results/tabs.tsx
/**
 * The Results tab registry (Studio S3a). TAB_ORDER is the spec's order (NII before EVE, and the SEG / EBP,
 * Liquidity and Instruments tabs added); a tab shows in the bar once TAB_BODIES has a body for it. Tasks 7 to 11 add
 * bodies here and nowhere else; a pack adds its own tabs through registry.ts, read by tabBody.
 */
import type { ReactNode } from "react";
import type { TabProps } from "./common";
import { AttributionTab } from "./AttributionTab";
import { EveTab } from "./EveTab";
import { FtpTab } from "./FtpTab";
import { GapTab } from "./GapTab";
import { InstrumentsTab } from "./InstrumentsTab";
import { LensesTab } from "./LensesTab";
import { LiquidityTab } from "./LiquidityTab";
import { MetricsTab } from "./MetricsTab";
import { NiiTab } from "./NiiTab";
import { OverviewTab } from "./OverviewTab";
import { RatesTab } from "./RatesTab";
import { SegTab } from "./SegTab";
import { ViewsTab } from "./ViewsTab";
import { registeredTab } from "../../registry";

export const TAB_ORDER = [
  { id: "overview", label: "Overview" },
  { id: "nii", label: "NII" },
  { id: "eve", label: "EVE" },
  { id: "gap", label: "Gap" },
  { id: "ftp", label: "FTP" },
  { id: "seg", label: "SEG / EBP" },
  { id: "liquidity", label: "Liquidity" },
  { id: "instruments", label: "Instruments" },
  { id: "attribution", label: "Attribution" },
  { id: "lenses", label: "Lenses" },
  { id: "rates", label: "Rates" },
  { id: "views", label: "Views" },
  { id: "metrics", label: "Metrics" },
] as const;

export type CoreTabId = (typeof TAB_ORDER)[number]["id"];
/** A core tab, or one a pack registered (registry.ts). */
export type TabId = CoreTabId | (string & {});

export const TAB_BODIES: Partial<Record<CoreTabId, (p: TabProps) => ReactNode>> = {
  overview: (p) => <OverviewTab {...p} />,
  eve: (p) => <EveTab {...p} />,
  nii: (p) => <NiiTab {...p} />,
  gap: (p) => <GapTab {...p} />,
  ftp: (p) => <FtpTab {...p} />,
  seg: (p) => <SegTab {...p} />,
  liquidity: (p) => <LiquidityTab {...p} />,
  instruments: (p) => <InstrumentsTab {...p} />,
  attribution: (p) => <AttributionTab {...p} />,
  lenses: (p) => <LensesTab {...p} />,
  rates: (p) => <RatesTab {...p} />,
  views: (p) => <ViewsTab {...p} />,
  metrics: (p) => <MetricsTab {...p} />,
};

export function liveTabs(): Array<{ id: CoreTabId; label: string }> {
  return TAB_ORDER.filter((t) => TAB_BODIES[t.id] !== undefined);
}

/** The body of a core tab, else of a registered one; undefined when neither holds it. */
export function tabBody(id: TabId): ((p: TabProps) => ReactNode) | undefined {
  return TAB_BODIES[id as CoreTabId] ?? registeredTab(id)?.body;
}

/**
 * The address a page's own links write. Every link inside a workspace names its target as
 * `{ ws, section, screen }`; the page state it carries is the query without the keys the workspace address
 * already names: the book and the as-of (the head names them), and under Results the `tab` the old layer
 * addresses used (the screen is the tab). The result picker's choice travels as `result` inside Results only.
 */
import { hrefFor, type Query, type ScreenId, type SectionId } from "./router";
import { registeredScreens } from "./registry";

/** A screen inside a workspace, and the run setup slot on run/setups. */
export interface ScreenAt {
  ws: string;
  section: SectionId;
  screen: ScreenId;
  slot?: string;
}

/**
 * The query a link to `section` carries, from the query a page holds. A page holds a query the router adapted for
 * it (`pageQuery` fills `book` and, for Results, `run` and `tab`), so those are taken back out here. Result goes
 * first so the address reads the same whichever page wrote it.
 */
export function addressQuery(section: SectionId, query: Query): Query {
  const rest: Query = { ...query };
  delete rest.book;
  delete rest.asOf;
  if (section !== "results") return rest;
  delete rest.tab;
  const picked = rest.result ?? rest.run;
  delete rest.result;
  delete rest.run;
  return picked === undefined ? rest : { result: picked, ...rest };
}

/** The hash of one screen, with the page state cleaned by `addressQuery`. */
export function screenHref(at: ScreenAt, query: Query = {}): string {
  return hrefFor({ ...at, query: addressQuery(at.section, query) });
}

/**
 * The Results screen a measure tab renders on: the tab id is the screen id, and the overview tab is the dashboard. A
 * tab a pack registered renders on the Results screen it registered for that tab (registry.ts).
 */
export function resultsScreenOfTab(tab: string | undefined): ScreenId {
  switch (tab) {
    case "nii": case "eve": case "gap": case "ftp": case "seg": case "liquidity": case "instruments": case "rates": case "attribution": case "views": case "metrics": case "lenses":
      return tab;
    default: {
      const registered = tab === undefined ? undefined : registeredScreens().find((s) => s.section === "results" && s.resultsTab === tab);
      return registered?.screen ?? "dashboard";
    }
  }
}

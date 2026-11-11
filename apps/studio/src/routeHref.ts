/** The address a route sits at: what the bar shows once a forward has resolved, and what a change of address closes the phone sheet by. */
import { analysisHref, homeHref, hrefFor, newWorkspaceHref, type Route } from "./router";

export function routeHref(route: Route): string {
  switch (route.kind) {
    case "screen":
      return hrefFor({ ws: route.ws, section: route.section, screen: route.screen, query: route.query, ...(route.slot === undefined ? {} : { slot: route.slot }) });
    case "analysis":
      return analysisHref(route.ws, route.step, route.query);
    case "new":
      return newWorkspaceHref();
    case "compare":
      return `#/workspaces/compare${Object.keys(route.query).length === 0 ? "" : `?${new URLSearchParams(route.query).toString()}`}`;
    case "home":
    case "legacy":
      return homeHref(route.kind === "home" ? route.query : {});
  }
}

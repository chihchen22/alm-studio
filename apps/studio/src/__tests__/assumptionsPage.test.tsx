// apps/studio/src/__tests__/assumptionsPage.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError, listAssumptionSets, setBlock, type AssumptionSetListItem } from "@alm/reader";
import type { BindingRowView, DeltaRowView } from "../assumptions/stackModel";
import { BindingsTable, DiffTable, LayerList, SaveBar, SetPicker } from "../pages/assumptions/AssumptionsViews";
import { AssumptionsBody, AssumptionsPage } from "../pages/assumptions/AssumptionsPage";
import { mockFetch } from "./fixtures/run";
import { HEAD } from "./fixtures/workspace";
import { policyBlock, routingPolicyBody } from "../assumptions/attachModel";
import { RoutingPolicyView } from "../pages/assumptions/RoutingPolicyCard";
import { errText } from "../errText";
import { attachWhy } from "../controls/AttachStored";
import { focusOnArrival, prefersReducedMotion, ROUTING_POLICY_FOCUS } from "../assumptions/arrivalFocus";

afterEach(() => vi.unstubAllGlobals());

const item = (id: string): AssumptionSetListItem => ({ id, label: `Label ${id}`, contentHash: `h-${id}` });
const SETS = [item("demo-behavioral-v1"), item("liquidity-stress-demo-v1"), item("rate-shock-v1"), item("stack-0123456789ab")];

describe("BindingsTable", () => {
  const rows: BindingRowView[] = [
    { familyId: "dda", kind: "nmd-decay", selector: "whole family", modelVersion: "kernel-nmd-decay-1", sourceId: "liquidity-stress-demo-v1", fromLayer: true },
    { familyId: "mma", kind: "nmd-beta", selector: "tier: retail", modelVersion: "kernel-beta-1", sourceId: "demo-behavioral-v1", fromLayer: false },
  ];

  it("prints family, kind, selector, model version and source set; a layer row carries the layer chip", () => {
    const html = renderToStaticMarkup(<BindingsTable rows={rows} />);
    for (const s of ["dda", "nmd-decay", "whole family", "kernel-nmd-decay-1", "liquidity-stress-demo-v1", "mma", "nmd-beta", "tier: retail", "kernel-beta-1", "demo-behavioral-v1"]) {
      expect(html).toContain(s);
    }
    expect(html).toContain('<th scope="col">Source set</th>');
    const layerRow = html.split("<tr>").find((r) => r.includes("liquidity-stress-demo-v1")) ?? "";
    const baseRow = html.split("<tr>").find((r) => r.includes("kernel-beta-1")) ?? "";
    expect(layerRow).toContain('class="chip chip-edited">layer</span>');
    expect(baseRow).not.toContain(">layer</span>");
  });
});

describe("DiffTable", () => {
  const rows: DeltaRowView[] = [
    { familyId: "dda", kind: "registered", selector: "whole family", path: "params.rate", change: "changed", from: { kind: "figure", text: "1", exact: "1" }, to: { kind: "figure", text: "5", exact: "5" } },
    { familyId: "sav", kind: "registered", selector: "whole family", path: "params.rate", change: "added", from: { kind: "absent", text: "Not stored" }, to: { kind: "figure", text: "3", exact: "3" } },
    { familyId: "mma", kind: "registered", selector: "whole family", path: "params.v", change: "removed", from: { kind: "figure", text: "0.25", exact: "0.25" }, to: { kind: "absent", text: "Not stored" } },
  ];

  it("prints added, removed and the from and to text verbatim", () => {
    const html = renderToStaticMarkup(<DiffTable diff={{ kind: "ok", rows }} baseId="demo-behavioral-v1" layersOn={1} />);
    expect(html).toContain("<table");
    expect(html).toContain(">added<");
    expect(html).toContain(">removed<");
    expect(html).toContain(">changed<");
    expect(html).toContain(">0.25<");
    expect(html).toContain(">Not stored<");
    expect(html).toContain("params.v");
  });

  it("an error prints the text in an alert and no table", () => {
    const html = renderToStaticMarkup(<DiffTable diff={{ kind: "error", text: "422: candidate refused" }} baseId="demo-behavioral-v1" layersOn={1} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("422: candidate refused");
    expect(html).not.toContain("<table");
  });

  it("no layer on: the stack is the base, no table", () => {
    const html = renderToStaticMarkup(<DiffTable diff={{ kind: "ok", rows: [] }} baseId="demo-behavioral-v1" layersOn={0} />);
    expect(html).toContain("No layer on: the stack is the base.");
    expect(html).not.toContain("<table");
  });
});

describe("SaveBar", () => {
  it("is enabled with an active layer and names the stack id", () => {
    const html = renderToStaticMarkup(<SaveBar ws="ws-a" setId="stack-0123456789ab" layersOn={1} busy={false} outcome={null} query={{}} onSave={() => {}} />);
    expect(html).toContain("Save stack stack-0123456789ab");
    expect(html).not.toContain("disabled");
  });

  it("is disabled with no active layer, with the reason as its title", () => {
    const html = renderToStaticMarkup(<SaveBar ws="ws-a" setId="stack-0123456789ab" layersOn={0} busy={false} outcome={null} query={{}} onSave={() => {}} />);
    expect(html).toContain('disabled=""');
    expect(html).toContain('title="Add a layer to make a stack"');
  });

  it("an already-saved stack links to the scenarios page with the set preselected", () => {
    const html = renderToStaticMarkup(
      <SaveBar ws="ws-a" setId="stack-0123456789ab" layersOn={1} busy={false} outcome={{ kind: "already-saved", id: "stack-0123456789ab" }} query={{ book: "b1", base: "x", layers: "y" }} onSave={() => {}} />,
    );
    expect(html).toContain("already saved");
    expect(html).toContain('href="#/ws/ws-a/run/setups?tab=scenarios&amp;set=stack-0123456789ab"');
  });

  it("a conflict prints the server text in an alert", () => {
    const html = renderToStaticMarkup(
      <SaveBar ws="ws-a" setId="stack-0123456789ab" layersOn={1} busy={false} outcome={{ kind: "conflict", id: "stack-0123456789ab", text: "409: id taken" }} query={{}} onSave={() => {}} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("409: id taken");
  });
});

describe("LayerList and SetPicker", () => {
  it("offers no stored stack as a layer and names them in a note", () => {
    const html = renderToStaticMarkup(<LayerList ws="ws-a" sets={SETS} baseId="demo-behavioral-v1" layers={["liquidity-stress-demo-v1"]} off={[]} query={{}} />);
    const addBlock = html.slice(html.indexOf("Add layer"));
    expect(addBlock).toContain('<option value="rate-shock-v1">');
    expect(addBlock).not.toContain('<option value="stack-0123456789ab">');
    expect(addBlock).not.toContain('<option value="demo-behavioral-v1">');
    expect(addBlock).not.toContain('<option value="liquidity-stress-demo-v1">');
    expect(html).toContain("Stored stacks can be a base, not a layer");
    expect(html).toContain("stack-0123456789ab");
  });

  it("every layer control is a link that writes the hash", () => {
    const html = renderToStaticMarkup(
      <LayerList ws="ws-a" sets={SETS} baseId="demo-behavioral-v1" layers={["liquidity-stress-demo-v1", "rate-shock-v1"]} off={["rate-shock-v1"]} query={{ book: "b1" }} />,
    );
    // Up on the bottom layer swaps it above rate-shock-v1.
    expect(html).toContain('href="#/ws/ws-a/assumptions/sets?base=demo-behavioral-v1&amp;layers=rate-shock-v1%2Cliquidity-stress-demo-v1&amp;off=rate-shock-v1"');
    // Turning rate-shock-v1 back on drops the off key.
    expect(html).toContain('href="#/ws/ws-a/assumptions/sets?base=demo-behavioral-v1&amp;layers=liquidity-stress-demo-v1%2Crate-shock-v1"');
    // Removing liquidity-stress-demo-v1.
    expect(html).toContain('href="#/ws/ws-a/assumptions/sets?base=demo-behavioral-v1&amp;layers=rate-shock-v1&amp;off=rate-shock-v1"');
    expect(html).toContain("Off");
  });

  it("the base picker lists every stored set, stacks included", () => {
    const html = renderToStaticMarkup(<SetPicker ws="ws-a" sets={SETS} baseId="demo-behavioral-v1" layers={[]} off={[]} query={{}} />);
    for (const s of SETS) expect(html).toContain(`<option value="${s.id}"`);
  });
});

describe("the page", () => {
  it("an empty store says to run the seed", async () => {
    mockFetch([["/api/assumption-sets", []]]);
    const sets = await listAssumptionSets();
    const html = renderToStaticMarkup(<AssumptionsBody ws="ws-a" sets={sets} query={{}} saved={null} busy={false} onSave={() => {}} />);
    expect(html).toContain("No assumption set stored: run the seed.");
  });

  it("renders a loading card before the list arrives", () => {
    expect(renderToStaticMarkup(<AssumptionsPage ws="ws-a" query={{}} />)).toContain("Reading the assumption sets");
  });
});

describe("Assumptions > Routing policy card", () => {
  const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const base = {
    stored: [{ id: "routing-demo-v1", label: "Demo routing" }, { id: "routing-alt-v2", label: "Alternative" }],
    by: "Chih", busy: false, note: null as string | null, blocked: null as string | null, onAttach: () => {}, onBy: () => {},
  };

  it("an attached policy shows its id and label, the title and the one-sentence explanation", () => {
    const t = text(renderToStaticMarkup(<RoutingPolicyView {...base} current={{ id: "routing-demo-v1", label: "Demo routing" }} />));
    expect(t).toContain("Routing policy");
    expect(t).toContain("The routing policy says which model handles each class of position.");
    expect(t).toContain("routing-demo-v1");
    expect(t).toContain("Demo routing");
    expect(t).not.toContain("None attached");
  });

  it("no policy attached says so and that Validate needs one", () => {
    const t = text(renderToStaticMarkup(<RoutingPolicyView {...base} current={null} />));
    expect(t).toContain("None attached. Validate needs one.");
  });

  it("offers the stored policies the workspace does not hold, with an Attach button", () => {
    const html = renderToStaticMarkup(<RoutingPolicyView {...base} current={{ id: "routing-demo-v1", label: "Demo routing" }} />);
    expect(html).toContain('<option value="routing-alt-v2">routing-alt-v2: Alternative</option>');
    expect(html).not.toContain('<option value="routing-demo-v1"');
    expect(html).toContain(">Attach</button>");
    expect(html).toContain('aria-label="Your name"');
  });

  it("the Attach body is a set of the routing-policies reference at the head revision with the typed name", () => {
    expect(routingPolicyBody({ ...HEAD, revision: 5 }, "routing-alt-v2", "Chih")).toEqual({
      expectedRevision: 5, by: "Chih", block: "assumptions", op: "set", ref: { collection: "routing-policies", id: "routing-alt-v2" },
    });
  });

  it("that body is what goes to the workspace route, verbatim", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string, init?: RequestInit) => {
      calls.push({ url: String(u), body: JSON.parse(String(init!.body)) });
      return new Response(JSON.stringify(HEAD), { status: 201, headers: { "content-type": "application/json" } });
    }));
    await setBlock(HEAD.id, routingPolicyBody({ ...HEAD, revision: 5 }, "routing-alt-v2", "Chih"));
    expect(calls).toEqual([{
      url: `/api/workspaces/${HEAD.id}/blocks`,
      body: { expectedRevision: 5, by: "Chih", block: "assumptions", op: "set", ref: { collection: "routing-policies", id: "routing-alt-v2" } },
    }]);
  });

  it("a locked, archived or superseded workspace gives a reason; an active one gives none", () => {
    expect(policyBlock({ ...HEAD, status: "active", lock: null })).toBeNull();
    expect(policyBlock({ ...HEAD, status: "locked" })).toBe("This workspace is locked by its sign-off. Clone it to change its routing policy.");
    expect(policyBlock({ ...HEAD, status: "archived" })).toBe("This workspace is archived and read-only.");
    expect(policyBlock({ ...HEAD, status: "superseded" })).toBe("This workspace was superseded and is read-only.");
  });

  it("with a reason the select is disabled, the button is off and the reason is printed", () => {
    const reason = "This workspace is locked by its sign-off. Clone it to change its routing policy.";
    const html = renderToStaticMarkup(<RoutingPolicyView {...base} current={null} blocked={reason} />);
    expect(html).toMatch(/<select[^>]*aria-label="Stored routing policy to attach"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Attach<\/button>/);
    expect(text(html)).toContain(reason);
  });

  it("without a typed name or a pick the button is off; with both it is live", () => {
    expect(renderToStaticMarkup(<RoutingPolicyView {...base} by="" current={null} />)).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Attach</);
    // No pick yet: off. (A pick is local state; the live case is the body test above.)
    expect(renderToStaticMarkup(<RoutingPolicyView {...base} current={null} />)).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Attach</);
  });

  it("the off button says why beside it: pick a policy first while there is one to pick, nothing once the list is empty", () => {
    const html = renderToStaticMarkup(<RoutingPolicyView {...base} current={null} />);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*aria-describedby="([^"]+)"[^>]*>Attach<\/button>/);
    const id = /aria-describedby="([^"]+)"/.exec(html)![1]!;
    expect(html).toContain(`<span class="muted" id="${id}">Pick a stored routing policy first.</span>`);
    const empty = renderToStaticMarkup(<RoutingPolicyView {...base} stored={[]} current={null} />);
    expect(empty).not.toContain("Pick a stored routing policy first.");
    expect(empty).not.toContain("aria-describedby");
  });

  it("the hint is the book and market controls' sentence, and it goes once a policy is picked", () => {
    const src = readFileSync(fileURLToPath(new URL("../pages/assumptions/RoutingPolicyCard.tsx", import.meta.url)), "utf8");
    expect(src).toContain('attachWhy({ selectLabel: "Attach a stored routing policy", pick, choices: choices.length, named, busy: off })');
    const card = { selectLabel: "Attach a stored routing policy", choices: 2, named: true, busy: false };
    expect(attachWhy({ ...card, pick: "" })).toBe("Pick a stored routing policy first.");
    // A pick is local state, so the card's own markup cannot show it; the helper the card calls answers for it.
    expect(attachWhy({ ...card, pick: "routing-alt-v2" })).toBeNull();
  });

  it("a refusal is the server sentence on one line through the shared helper", () => {
    const e = new ApiError(409, "conflict", "revision 4 expected, head is 5");
    const html = renderToStaticMarkup(<RoutingPolicyView {...base} current={null} note={errText(e)} />);
    expect(text(html)).toContain("409: revision 4 expected, head is 5");
    expect(errText(e)).not.toContain("\n");
  });

  it("the Assumptions page mounts the card from the workspace head", () => {
    const src = readFileSync(fileURLToPath(new URL("../pages/assumptions/AssumptionsPage.tsx", import.meta.url)), "utf8");
    expect(src).toContain("<RoutingPolicyCard head={props.head}");
  });
});

describe("Assumptions > Assumption sets arrived at with focus=routing-policy", () => {
  const targets = (disabled = false) => ({ card: { scrollIntoView: vi.fn() }, select: { disabled, focus: vi.fn() }, heading: { focus: vi.fn() } });

  it("the focus value is the one the Overview next step writes", () => {
    expect(ROUTING_POLICY_FOCUS).toBe("routing-policy");
  });

  it("scrolls the card into view and focuses its select once per arrival, however often the page renders", () => {
    const t = targets();
    const done = { current: false };
    expect(focusOnArrival({ focus: "routing-policy", ready: true, done }, t, false)).toBe(true);
    expect(focusOnArrival({ focus: "routing-policy", ready: true, done }, t, false)).toBe(false);
    expect(t.card.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(t.card.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(t.select.focus).toHaveBeenCalledTimes(1);
    expect(t.select.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(t.heading.focus).not.toHaveBeenCalled();
    expect(done.current).toBe(true);
  });

  it("with reduced motion the scroll is not smooth", () => {
    const t = targets();
    focusOnArrival({ focus: "routing-policy", ready: true, done: { current: false } }, t, true);
    expect(t.card.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });

  it("a select that cannot take focus hands it to the card heading", () => {
    const t = targets(true);
    focusOnArrival({ focus: "routing-policy", ready: true, done: { current: false } }, t, false);
    expect(t.select.focus).not.toHaveBeenCalled();
    expect(t.heading.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("waits while the stored policies are read, then acts once they are", () => {
    const t = targets();
    const done = { current: false };
    expect(focusOnArrival({ focus: "routing-policy", ready: false, done }, t, false)).toBe(false);
    expect(t.card.scrollIntoView).not.toHaveBeenCalled();
    expect(done.current).toBe(false);
    expect(focusOnArrival({ focus: "routing-policy", ready: true, done }, t, false)).toBe(true);
    expect(t.card.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("without the value, or with another one, it neither scrolls nor focuses", () => {
    for (const focus of [undefined, "", "sets"]) {
      const t = targets();
      expect(focusOnArrival({ focus, ready: true, done: { current: false } }, t, false)).toBe(false);
      expect(t.card.scrollIntoView).not.toHaveBeenCalled();
      expect(t.select.focus).not.toHaveBeenCalled();
      expect(t.heading.focus).not.toHaveBeenCalled();
    }
  });

  it("reduced motion is read from the media query, and is off where there is none", () => {
    vi.stubGlobal("window", { matchMedia: (q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)" }) });
    expect(prefersReducedMotion()).toBe(true);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    expect(prefersReducedMotion()).toBe(false);
    vi.stubGlobal("window", {});
    expect(prefersReducedMotion()).toBe(false);
  });

  it("the card heading can take focus without joining the tab order", () => {
    const html = renderToStaticMarkup(<RoutingPolicyView stored={[]} by="" busy={false} note={null} blocked={null} onAttach={() => {}} onBy={() => {}} current={null} />);
    expect(html).toContain('<div class="card-title" tabindex="-1">Routing policy</div>');
  });

  it("the page hands the card the query's focus value and one arrival record that outlives the card", () => {
    const src = readFileSync(fileURLToPath(new URL("../pages/assumptions/AssumptionsPage.tsx", import.meta.url)), "utf8");
    expect(src).toContain("const arrived = useRef(false);");
    expect(src).toContain("arrival={{ focus: props.query.focus, done: arrived }}");
  });
});

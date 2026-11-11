/**
 * "Discard edits" on the run setup editor (item c). The numeric fields keep what is typed in their own state,
 * so a discard that only resets the draft left the typed text on screen while the stored value came back underneath.
 * The Measures body is keyed on a discard counter, so every field starts again from the stored setup.
 *
 * The studio test environment has no DOM, so this file carries a small hooks-only tree walker: it expands function
 * components with useState (the only hook the editor tree uses), keeps state by the component's key path, drops the
 * state of any path a render no longer reaches (an unmount), and lets a test type into a control by its aria-label.
 * The `react` mock swaps only useState; every other export is the real one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Fragment, createElement, type ReactElement } from "react";
import type { RunSetup } from "@alm/reader";
import { SetupEditor, type SetupEditorContext } from "../run/SetupEditor";
import { withLiquidityStress } from "../rows/setupRows";
import { LIBRARIES, SLATES, STANDARD_ALCO } from "./fixtures/setup";

const hooks = vi.hoisted(() => ({
  current: null as null | { path: string; index: number; states: Map<string, unknown[]>; rerender: () => void },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = (init: unknown) => {
    const ctx = hooks.current;
    if (ctx === null) throw new Error("useState called outside the test renderer");
    const slots = ctx.states.get(ctx.path) ?? [];
    ctx.states.set(ctx.path, slots);
    const at = ctx.index++;
    if (!(at in slots)) slots[at] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      slots[at] = typeof v === "function" ? (v as (old: unknown) => unknown)(slots[at]) : v;
      ctx.rerender();
    };
    return [slots[at], set];
  };
  return { ...actual, default: { ...actual, useState }, useState };
});

interface Host {
  type: string;
  props: Record<string, unknown>;
  kids: Array<Host | string>;
}

/** Mount `element`, return a handle that re-renders after every state change. */
function mount(element: ReactElement) {
  const states = new Map<string, unknown[]>();
  let tree: Array<Host | string> = [];
  const render = () => {
    const seen = new Set<string>();
    const ctx = { path: "", index: 0, states, rerender: render };
    const expand = (node: unknown, path: string, out: Array<Host | string>): void => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (typeof node === "string" || typeof node === "number") {
        out.push(String(node));
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((n, i) => expand(n, `${path}[${i}]`, out));
        return;
      }
      const el = node as ReactElement<Record<string, unknown>>;
      const here = `${path}/${el.key ?? ""}`;
      if (el.type === Fragment) {
        expand(el.props.children, here, out);
      } else if (typeof el.type === "function") {
        const fn = el.type as (p: Record<string, unknown>) => unknown;
        const saved = { path: ctx.path, index: ctx.index };
        ctx.path = `${here}:${fn.name}`;
        ctx.index = 0;
        seen.add(ctx.path);
        const rendered = fn(el.props);
        const path2 = ctx.path;
        ctx.path = saved.path;
        ctx.index = saved.index;
        expand(rendered, path2, out);
      } else {
        const kids: Array<Host | string> = [];
        expand(el.props.children, here, kids);
        out.push({ type: String(el.type), props: el.props, kids });
      }
    };
    hooks.current = ctx;
    const next: Array<Host | string> = [];
    expand(element, "", next);
    hooks.current = null;
    for (const key of [...states.keys()]) if (!seen.has(key)) states.delete(key);
    tree = next;
  };
  render();
  const find = (label: string): Host => {
    const walk = (nodes: Array<Host | string>): Host | null => {
      for (const n of nodes) {
        if (typeof n === "string") continue;
        if (n.props["aria-label"] === label) return n;
        const hit = walk(n.kids);
        if (hit !== null) return hit;
      }
      return null;
    };
    const hit = walk(tree);
    if (hit === null) throw new Error(`no control labelled ${label}`);
    return hit;
  };
  return {
    value: (label: string) => String(find(label).props.value),
    type: (label: string, text: string) => (find(label).props.onChange as (e: unknown) => void)({ target: { value: text } }),
    click: (text: string) => {
      const walk = (nodes: Array<Host | string>): Host | null => {
        for (const n of nodes) {
          if (typeof n === "string") continue;
          if (n.type === "button" && n.kids.join("") === text) return n;
          const hit = walk(n.kids);
          if (hit !== null) return hit;
        }
        return null;
      };
      const button = walk(tree);
      if (button === null) throw new Error(`no button reading ${text}`);
      (button.props.onClick as () => void)();
    },
  };
}

const CONTEXT: SetupEditorContext = {
  defaultSetId: "example-behavioral-v1",
  setIds: ["example-behavioral-v1"],
  balancePlanIds: [],
  libraries: LIBRARIES,
  slates: SLATES,
  coaNodes: [{ id: "coa-example-loans", label: "Loans" }],
};
const noop = () => {};
const STORED: RunSetup = { ...withLiquidityStress(STANDARD_ALCO, true), id: "rs-00000000000000a0" };
const CELL = "Moderate: savings pool outflow per month, percent";

beforeEach(() => {
  hooks.current = null;
});

describe("SetupEditor, Discard edits", () => {
  it("puts an edited stress cell back to the stored value, in the field and in the draft", () => {
    const saved: Array<Omit<RunSetup, "id">> = [];
    const ed = mount(
      createElement(SetupEditor, {
        setup: STORED, context: CONTEXT, validation: null, readiness: null, by: "Chih Chen", readOnlyReason: null, busy: false,
        message: null, onBy: noop, onSave: (d) => saved.push(d), onValidate: noop, onLaunch: noop,
      }),
    );
    expect(ed.value(CELL)).toBe("4");
    ed.type(CELL, "7.5");
    expect(ed.value(CELL)).toBe("7.5");
    ed.click("Discard edits");
    // The field shows the stored value again, not the typed text.
    expect(ed.value(CELL)).toBe("4");
    // The draft is the stored setup again: an edit after the discard saves the stored 4 percent outflow beside the
    // 40 percent renewal just typed, and nothing of the 7.5 remains.
    ed.type("Moderate: wholesale renewal, percent", "40");
    ed.click("Save as a new version");
    expect(saved.length).toBe(1);
    expect(saved[0]!.liquidityStress!.table.moderate.hysOutflowMonthly).toBeCloseTo(0.04, 12);
    expect(saved[0]!.liquidityStress!.table.moderate.wholesaleRenewal).toBeCloseTo(0.4, 12);
  });

  it("a second discard cycle works the same way", () => {
    const ed = mount(
      createElement(SetupEditor, {
        setup: STORED, context: CONTEXT, validation: null, readiness: null, by: "Chih Chen", readOnlyReason: null, busy: false,
        message: null, onBy: noop, onSave: noop, onValidate: noop, onLaunch: noop,
      }),
    );
    for (const typed of ["8", "9"]) {
      ed.type(CELL, typed);
      expect(ed.value(CELL)).toBe(typed);
      ed.click("Discard edits");
      expect(ed.value(CELL)).toBe("4");
    }
  });
});

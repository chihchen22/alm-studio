/**
 * Derived curve routes (plan Task 6). The shape follows curveSetups.ts:
 *
 *   POST /api/workspaces/:id/derived-curves            { curve, expectedRevision, by } -> 201 { id, revision } (200 when unchanged)
 *   GET  /api/workspaces/:id/derived-curves            { curves: [{ id, curveId, label, base, spreads, source?, estimatedOnDefault? }], missing? }
 *   GET  /api/derived-curves/:docId                    one immutable derived curve document
 *   POST /api/workspaces/:id/derived-curves/estimate   { from, minus, tenors } -> 200 { ok: true, spreads } | 422 { ok: false, refusals }
 *
 * A derived curve is immutable. The document is the block as validateDerivedCurve returns it and its id
 * is `dc-<16 hex of contentHash(block)>`, so identical content is the same document. The market block
 * holds one slot per curve, named by the block's own `id` (the id an index's `spreadCurve` names): saving
 * under an id a slot already holds moves that slot's `current`; a new id adds a slot. There is no active
 * pointer: a launch pins every saved curve an index of the run's market names (setupCompile.ts). In the
 * list, `id` is the document id (as the curve-setups list) and `curveId` the curve's own id.
 *
 * History. Each save is one `set-block` line on the market block marked `derivedCurve: "edit"`: op "add"
 * for a new slot, op "set" for an edit. Saving what a slot already holds writes nothing.
 *
 * Order of refusals, as curveSetups.ts: workspace 404, then the body (422; the curve is judged by the
 * engine's validator, whose sentences are returned verbatim, then by the slot bounds LINEAGE_PATTERN and
 * NAME_MAX, which the validator restates), and only then, under the workspace lock, the writable status
 * 409 and the revision 409. The document is written only after those pass.
 *
 * Stamp. A curve whose `source.from` or `source.minus` names `platform-default`
 * is saved with `estimatedOnDefault`, the platform default curve version its spreads were estimated on.
 * The server is the one authority on it: a posted stamp is ignored. Under the workspace lock, when the
 * slot of the posted curve's id holds a curve with the same spreads and the same source, the posted curve
 * was estimated where that one was, so it inherits estimatedOnDefaultOf of it; when that curve is
 * unstamped (stored before the stamp existed) and the posted content equals it, its bytes are reused
 * unstamped, so the save answers 200 and writes nothing, as for any slot that already holds what is
 * posted. Otherwise (a new id, new spreads or a new source) the curve is stamped with curveDefaultOf of the
 * workspace's base market snapshot, the default the estimate reads; when that snapshot is missing or its
 * marker does not read, the curve is saved unstamped. A typed grid (no `source`) or a source of two curve
 * setups was not estimated on the platform default and is never stamped; the validator refuses a stamp
 * posted with one. Both GET routes answer estimatedOnDefault as the curve means it (estimatedOnDefaultOf:
 * 1 for an unstamped curve whose source names platform-default), so a GET-to-POST round trip of a curve
 * stored before the stamp neither writes a document nor clears its warning. Readiness warns when a run's
 * default differs (readiness.ts); nothing else moves.
 *
 * Estimate. `from` and `minus` each name a saved curve setup by its own id (the id a derived curve's
 * `base` names), or `platform-default`, the platform default curve the workspace's base snapshot builds
 * (curve default version 2, or version 1 on a market marked `curveDefault: 1` or one version 2 cannot
 * take; curveDefaultOf names which). The tenors are
 * judged first (1 to 60 rows, each a whole month from 1 to 360, strictly ascending; ruling R8), and when
 * they pass, a row above 12 months that is not a whole number of years is refused by row (fillTenorProblems),
 * all before any curve is built. Then the engine's estimateSpreads reads, at the cut-off, the n-month index
 * rate gap up to 12 months and above 12 months the par swap rate gap on whole years, as a swap index reads
 * it; a row beyond the 1000 bp a derived curve carries is refused by row, so a fill
 * never produces a grid the save would refuse. The estimate writes nothing.
 *
 * Not mirrored to the database (`derived-curves` is not a mirrored collection, as `curve-setups` is not).
 */
import {
  buildCurveFromSetup,
  CurveBuildError,
  DERIVED_CURVE_ID_PATTERN,
  estimatedOnDefaultOf,
  estimateSpreads,
  fillTenorProblems,
  MAX_ABS_SPREAD_BP,
  MAX_SPREAD_ROWS,
  MAX_SPREAD_TENOR_MONTHS,
  PLATFORM_DEFAULT_CURVE,
  validateCurveSetup,
  validateDerivedCurve,
  type DerivedCurveBlock,
  type MarketWithCurveSetup,
} from "@alm/engine";
import { buildBaseCurve, curveDefaultOf } from "@alm/engine/src/scenario";
import type { MarketSnapshot, ZeroCurve } from "@alm/kernel";
import type { PlatformContext } from "../../context";
import { AlreadyExistsError, NotFoundError, sha256Hex, type DocumentMeta } from "../../store/store";
import { derivedCurveIdOf } from "../../workspaces/derivedCurveSlot";
import { assertWritable, LINEAGE_PATTERN, NAME_MAX, requireBy, requireExpectedRevision } from "../../workspaces/rules";
import type { DerivedCurveSlot, DerivedCurvesBlock, DocRef, WorkspaceManifest } from "../../workspaces/types";
import { RevisionConflict } from "../../workspaces/workspaceStore";
import { unprocessable } from "../errors";
import type { RouteResult, Router } from "../router";

type Body = Record<string, unknown>;

/**
 * The refusal for one estimated row the cap refuses (M7): the value rounded to two decimals, and a
 * non-finite value in its own sentence, so the reader never sees a raw float or "NaN bp". `i` is 0-based.
 */
export function estimateRowRefusal(i: number, tenorMonths: number, spreadBp: number): string {
  const row = `row ${i + 1} (${tenorMonths} months)`;
  if (!Number.isFinite(spreadBp)) {
    return `${row}: the estimated spread is not a finite number of basis points; the two curves give no readable gap at this tenor`;
  }
  return `${row}: the estimated spread of ${Math.round(spreadBp * 100) / 100} bp is beyond the ${MAX_ABS_SPREAD_BP} bp a derived curve carries`;
}

function bodyOf(raw: unknown): Body {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw unprocessable("the request body must be a JSON object");
  return raw as Body;
}

/** A refused curve: the typed error body, plus the sentences at the top level for the Studio grid. */
function refused(refusals: string[]): RouteResult {
  return {
    kind: "json",
    status: 422,
    value: { error: { code: "validation", message: refusals.join("; "), detail: { field: "curve", refusals } }, refusals },
  };
}

/** The validator's block, or its sentences; the slot bounds are the validator's own, restated as the server's. */
function judge(raw: unknown): { ok: true; block: DerivedCurveBlock } | { ok: false; refusals: string[] } {
  const checked = validateDerivedCurve(raw);
  if (!checked.ok) return checked;
  if (!LINEAGE_PATTERN.test(checked.block.id)) return { ok: false, refusals: [`the derived curve's "id" must be 1 to 70 characters from A-Z a-z 0-9 . _ -`] };
  if (checked.block.label.length > NAME_MAX) return { ok: false, refusals: [`the derived curve's "label" must be 1 to ${NAME_MAX} characters`] };
  return checked;
}

interface Listed {
  id: string;
  curveId: string;
  label: string;
  base: string;
  spreads: DerivedCurveBlock["spreads"];
  source?: DerivedCurveBlock["source"];
  estimatedOnDefault?: DerivedCurveBlock["estimatedOnDefault"];
}

/** An estimate refusal: `{ ok: false, refusals }`, as the curve-setups preview answers. */
const estimateRefused = (refusals: string[]): RouteResult => ({ kind: "json", status: 422, value: { ok: false, refusals } });

/** The tenor list's refusals (ruling R8): judged before the engine sees a tenor, each row named 1-based. */
function tenorRefusals(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SPREAD_ROWS) return [`"tenors" must list 1 to ${MAX_SPREAD_ROWS} tenors in months`];
  const out: string[] = [];
  raw.forEach((v, i) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_SPREAD_TENOR_MONTHS) {
      out.push(`row ${i + 1}: tenorMonths must be a whole number of months from 1 to ${MAX_SPREAD_TENOR_MONTHS}`);
      return;
    }
    const prev = raw[i - 1];
    if (i > 0 && typeof prev === "number" && Number.isInteger(prev) && v <= prev) out.push(`row ${i + 1}: tenorMonths must be greater than row ${i}'s (${prev})`);
  });
  return out;
}

export function registerDerivedCurveRoutes(router: Router, ctx: PlatformContext): void {
  const { store, workspaces: wsStore } = ctx;

  /** The platform default curve version the workspace's base snapshot builds; null when there is none to read. */
  const baseDefaultOf = (head: WorkspaceManifest): 1 | 2 | null => {
    const snapRef = head.blocks.market.snapshot;
    if (snapRef === null) return null;
    let snapshot: MarketSnapshot;
    try {
      snapshot = store.getDocument<MarketSnapshot>(snapRef.collection, snapRef.id).doc;
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
    try {
      return curveDefaultOf(snapshot);
    } catch {
      // A marker value the engine refuses (seeds only; decision 73): the estimate and the launch refuse it in words.
      return null;
    }
  };

  /** The slot's current curve under this curve id, as the validator reads it; null for a new id or a document that does not read. */
  const currentOf = (head: WorkspaceManifest, curveId: string): DerivedCurveBlock | null => {
    const slot = head.blocks.market.derivedCurves?.curves.find((s) => s.lineageKey === curveId);
    if (slot === undefined || slot.current.collection !== "derived-curves") return null;
    let raw: unknown;
    try {
      raw = store.getDocument<unknown>("derived-curves", slot.current.id).doc;
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
    const checked = validateDerivedCurve(raw);
    return checked.ok ? checked.block : null;
  };

  /** Whether two curves carry the same spread grid and the same source: the same estimate, whatever the label or base. */
  const sameEstimate = (a: DerivedCurveBlock, b: DerivedCurveBlock): boolean =>
    JSON.stringify(a.spreads) === JSON.stringify(b.spreads) && JSON.stringify(a.source ?? null) === JSON.stringify(b.source ?? null);

  /** The block as stored (decision 63; the module header's Stamp paragraph). The server alone writes the stamp. */
  const stamped = (block: DerivedCurveBlock, head: WorkspaceManifest): DerivedCurveBlock => {
    const { estimatedOnDefault: _posted, ...rest } = block;
    void _posted; // a posted stamp is never trusted
    if (estimatedOnDefaultOf(rest) === null) return rest;
    const prev = currentOf(head, rest.id);
    if (prev !== null && sameEstimate(prev, rest)) {
      // The slot's spreads and source as they stand: estimated where the slot's curve was. An unstamped curve
      // posted back unchanged keeps its bytes, so the save answers 200 and writes nothing.
      if (prev.estimatedOnDefault === undefined && derivedCurveIdOf(prev) === derivedCurveIdOf(rest)) return rest;
      return { ...rest, estimatedOnDefault: estimatedOnDefaultOf(prev) ?? 1 };
    }
    const version = baseDefaultOf(head);
    return version === null ? rest : { ...rest, estimatedOnDefault: version };
  };

  /** A stored curve as the routes answer it: estimatedOnDefault as the curve means it (estimatedOnDefaultOf), stamped or not. */
  const answered = (doc: DerivedCurveBlock): DerivedCurveBlock => {
    const on = estimatedOnDefaultOf(doc);
    return on === null || doc.estimatedOnDefault === on ? doc : { ...doc, estimatedOnDefault: on };
  };

  router.add("GET", "/api/workspaces/:id/derived-curves", (req) => {
    const head = wsStore.head(req.params.id ?? ""); // 404 for an unknown workspace
    const curves: Listed[] = [];
    // A slot whose document is gone never takes the list down: it is skipped and named under `missing`
    // (left out when empty); readiness and the launch name it when an index reads it.
    const missing: Array<{ id: string; problem: string }> = [];
    for (const slot of head.blocks.market.derivedCurves?.curves ?? []) {
      let doc: DerivedCurveBlock;
      try {
        doc = store.getDocument<DerivedCurveBlock>("derived-curves", slot.current.id).doc;
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
        missing.push({ id: slot.current.id, problem: `the derived curve document "${slot.current.id}" is not in the store` });
        continue;
      }
      curves.push({
        id: slot.current.id,
        curveId: doc.id,
        label: doc.label,
        base: doc.base,
        spreads: doc.spreads,
        ...(doc.source !== undefined ? { source: doc.source } : {}),
        ...(answered(doc).estimatedOnDefault !== undefined ? { estimatedOnDefault: answered(doc).estimatedOnDefault } : {}),
      });
    }
    return { kind: "json", value: missing.length > 0 ? { curves, missing } : { curves } };
  });

  router.add("GET", "/api/derived-curves/:docId", (req) => ({
    kind: "json",
    value: answered(store.getDocument<DerivedCurveBlock>("derived-curves", req.params.docId ?? "").doc),
  }));

  router.add("POST", "/api/workspaces/:id/derived-curves", (req) => {
    const workspaceId = req.params.id ?? "";
    wsStore.head(workspaceId); // 404 before the body is judged
    const body = bodyOf(req.json());
    const by = requireBy(body);
    const expectedRevision = requireExpectedRevision(body);
    const judged = judge(body.curve);
    if (!judged.ok) return refused(judged.refusals);

    return wsStore.withLock([workspaceId], () => {
      const head = wsStore.head(workspaceId);
      assertWritable(head);
      if (head.revision !== expectedRevision) throw new RevisionConflict(workspaceId, expectedRevision, head.revision);
      // The stamp reads the base market of this head, so the document id is fixed under the lock.
      const doc = stamped(judged.block, head);
      const id = derivedCurveIdOf(doc);

      // Append-only: identical content is the same document, so an existing id is reused as it stands.
      let meta: DocumentMeta;
      if (store.has("derived-curves", id)) {
        meta = store.getMeta("derived-curves", id);
      } else {
        try {
          meta = store.putDocument("derived-curves", id, doc, { label: doc.label, workspaceId });
        } catch (err) {
          if (!(err instanceof AlreadyExistsError)) throw err;
          meta = store.getMeta("derived-curves", id); // another request wrote the same bytes first
        }
      }

      const slots = head.blocks.market.derivedCurves?.curves ?? [];
      const existing = slots.find((s) => s.lineageKey === doc.id);
      if (existing !== undefined && existing.current.id === id) {
        // Saving what the slot already holds changes nothing: no revision, no history line.
        return { kind: "json", status: 200, value: { id, revision: head.revision } } as const;
      }
      const ref: DocRef = { collection: "derived-curves", id, contentHash: meta.contentHash, pinnedAt: new Date().toISOString() };
      const slot: DerivedCurveSlot = { lineageKey: doc.id, current: ref };
      const derivedCurves: DerivedCurvesBlock = { curves: existing === undefined ? [...slots, slot] : slots.map((s) => (s === existing ? slot : s)) };
      const next: WorkspaceManifest = { ...head, blocks: { ...head.blocks, market: { ...head.blocks.market, derivedCurves } } };
      const manifest = wsStore.commit(
        workspaceId,
        expectedRevision,
        by,
        { kind: "set-block", block: "market", op: existing === undefined ? "add" : "set", ref: { collection: "derived-curves", id }, derivedCurve: "edit" },
        next,
      );
      return { kind: "json", status: 201, value: { id, revision: manifest.revision } } as const;
    });
  });

  router.add("POST", "/api/workspaces/:id/derived-curves/estimate", (req) => {
    const workspaceId = req.params.id ?? "";
    const head = wsStore.head(workspaceId); // 404 before the body is judged
    const body = bodyOf(req.json());

    const refusals: string[] = [];
    // Each name is judged as an id before any lookup reads it (M4).
    for (const key of ["from", "minus"] as const) {
      if (typeof body[key] !== "string" || !DERIVED_CURVE_ID_PATTERN.test(body[key] as string)) {
        refusals.push(`"${key}" must name a saved curve setup by its own id (1 to 70 characters from A-Z a-z 0-9 . _ -), or ${PLATFORM_DEFAULT_CURVE}`);
      }
    }
    const tenorProblems = tenorRefusals(body.tenors);
    refusals.push(...tenorProblems);
    // A fill row above 12 months reads the par swap rate, so it must sit on whole years (decision 46).
    if (tenorProblems.length === 0) refusals.push(...fillTenorProblems(body.tenors as number[]));
    if (refusals.length > 0) return estimateRefused(refusals);
    const tenors = body.tenors as number[];

    /** The curve a name builds, as the run would build it, or the sentence why it cannot. */
    const curveOf = (key: "from" | "minus", name: string): ZeroCurve | string => {
      if (name === PLATFORM_DEFAULT_CURVE) {
        const snapRef = head.blocks.market.snapshot;
        if (snapRef === null) {
          return `${PLATFORM_DEFAULT_CURVE} builds from the workspace's base market snapshot, and workspace "${workspaceId}" has none; attach one on Market > Yield curves`;
        }
        let snapshot: MarketSnapshot;
        try {
          snapshot = store.getDocument<MarketSnapshot>(snapRef.collection, snapRef.id).doc;
        } catch (err) {
          if (err instanceof NotFoundError) return `${PLATFORM_DEFAULT_CURVE} builds from the base market snapshot "${snapRef.id}", which is not in the store`;
          throw err;
        }
        // The platform default curve the market builds (the marker kept, so a marked market reads version 1,
        // as curveDefaultOf says and the save stamps), whatever curveSetup block a hand-built snapshot carries.
        const { curveSetup: _drop, ...legacy } = snapshot as MarketWithCurveSetup;
        void _drop;
        try {
          return buildBaseCurve(legacy as MarketSnapshot);
        } catch (err) {
          return `${PLATFORM_DEFAULT_CURVE}, the platform default curve, does not build from the base market snapshot "${snapRef.id}": ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      const slot = head.blocks.market.curveSetups?.setups.find((s) => s.lineageKey === name);
      if (slot === undefined) return `"${key}" names curve setup "${name}", which workspace "${workspaceId}" does not hold`;
      let bytes: Buffer;
      try {
        bytes = store.getDocumentBytes("curve-setups", slot.current.id);
      } catch (err) {
        if (err instanceof NotFoundError) return `curve setup "${name}" (${slot.current.id}) is not in the store`;
        throw err;
      }
      if (sha256Hex(bytes) !== slot.current.contentHash) return `curve setup "${name}" (${slot.current.id}) no longer matches the workspace's pin`;
      const checked = validateCurveSetup(JSON.parse(bytes.toString("utf8")) as unknown);
      if (!checked.ok) return `curve setup "${name}" is not a readable curve setup: ${checked.refusals.join("; ")}`;
      try {
        return buildCurveFromSetup(checked.block).curve;
      } catch (err) {
        if (err instanceof CurveBuildError) return `curve setup "${name}" does not build: ${err.refusals.join("; ")}`;
        throw err;
      }
    };
    const from = curveOf("from", body.from as string);
    const minus = curveOf("minus", body.minus as string);
    const named = [from, minus].filter((c): c is string => typeof c === "string");
    if (named.length > 0) return estimateRefused([...new Set(named)]);

    const spreads = estimateSpreads(from as ZeroCurve, minus as ZeroCurve, tenors);
    const over = spreads
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => !Number.isFinite(s.spreadBp) || Math.abs(s.spreadBp) > MAX_ABS_SPREAD_BP)
      .map(({ s, i }) => estimateRowRefusal(i, s.tenorMonths, s.spreadBp));
    if (over.length > 0) return estimateRefused(over);
    return { kind: "json", value: { ok: true, spreads } };
  });
}

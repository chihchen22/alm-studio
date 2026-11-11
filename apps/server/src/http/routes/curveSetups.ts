/**
 * Curve setup routes (plan Task 8). The shape follows runSetups.ts:
 *
 *   POST /api/workspaces/:id/curve-setups                     { setup, expectedRevision, by } -> 201 { id, revision }
 *   GET  /api/workspaces/:id/curve-setups                     { setups: [{ id, label, interpolation, dayCount, compounding, rows, active }] }
 *   POST /api/workspaces/:id/curve-setups/:setupId/activate   { expectedRevision, by } -> { revision }
 *   POST /api/workspaces/:id/curve-setups/deactivate          { expectedRevision, by } -> { revision }
 *   GET  /api/curve-setups/:docId                             one immutable curve setup document
 *   POST /api/curve-setups/preview                            { setup } -> 200 { ok: true, quoteNodes, denseCount, warnings } | 422 { ok: false, refusals }
 *
 * A setup is immutable. The document is the block as validateCurveSetup returns it (rows sorted by node
 * tenor) and its id is `cs-<16 hex of contentHash(block)>`, so identical content is the same document.
 * The market block holds one slot per setup lineage, named by the block's own `id`: saving under an id
 * the block already holds moves that slot's `current` (and the active pointer with it, when that slot was
 * active); a new id adds a slot. The block's `id` is that slot's lineage key, so it is bounded as runSetups.ts
 * bounds a slot id (1 to 70 characters from A-Z a-z 0-9 . _ -) and refused in words otherwise; the id
 * `platform-default` is reserved for the platform's own curve, which derived curves name by it. Its
 * `label` and `baseCurve` are bounded at NAME_MAX (80), as a workspace name is.
 *
 * History. Each write is one `set-block` line on the market block: a new setup is op "add"; an activate is
 * op "set" with no marker; an edit-save (a new document in an existing slot) is op "set" with
 * `curveSetup: "edit"`; a deactivate is op "remove" naming the setup that was active, with
 * `curveSetup: "deactivate"`. Deactivate leaves the `active` key out of the slot (never null), so the
 * workspace runs on the platform default curve again; with no setup active it is a 409 (run-setups has no
 * pointer to clear, so there is no sibling no-op to follow).
 *
 * Order of refusals, as runSetups.ts: workspace 404, then the body (422; the setup is judged by the
 * engine's validator, whose sentences are returned verbatim, then by its builder, so a setup that cannot
 * bootstrap is never saved), and only then, under the workspace lock, the writable status 409 (the
 * slots' own sentence: locked, archived, superseded) and the revision 409. The document is written only
 * after those pass, so a refused request leaves no orphan. A refused setup answers 422 with the typed
 * error body plus `refusals`, the sentence list, at the top level.
 *
 * Not mirrored to the database (`curve-setups` is not a mirrored collection, as `run-setups` is not).
 */
import { buildCurveFromSetup, CurveBuildError, PLATFORM_DEFAULT_CURVE, validateCurveSetup, type CurveInput, type CurveSetupBlock } from "@alm/engine";
import type { PlatformContext } from "../../context";
import { AlreadyExistsError, NotFoundError, type DocumentMeta } from "../../store/store";
import { curveSetupIdOf } from "../../workspaces/curveSetupSlot";
import { assertWritable, LINEAGE_PATTERN, NAME_MAX, requireBy, requireExpectedRevision } from "../../workspaces/rules";
import type { CurveSetupSlot, CurveSetupsBlock, DocRef, WorkspaceManifest } from "../../workspaces/types";
import { RevisionConflict } from "../../workspaces/workspaceStore";
import { conflict, notFound, unprocessable } from "../errors";
import type { RouteResult, Router } from "../router";

type Body = Record<string, unknown>;

const LINEAGE_SENTENCE = `the setup's "id" names its slot: 1 to 70 characters from A-Z a-z 0-9 . _ -`;
/** A derived curve names the platform default curve by this id, so a curve setup may not carry it (B2 final I1). */
const RESERVED_SENTENCE = `the curve setup id "${PLATFORM_DEFAULT_CURVE}" is reserved for the platform's own curve; pick another id`;

function bodyOf(raw: unknown): Body {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw unprocessable("the request body must be a JSON object");
  return raw as Body;
}

/** A refused setup: the typed error body, plus the sentences at the top level for the Studio grid. */
function refused(refusals: string[]): RouteResult {
  return {
    kind: "json",
    status: 422,
    value: { error: { code: "validation", message: refusals.join("; "), detail: { field: "setup", refusals } }, refusals },
  };
}

/** The validator's block, or its sentences; then the builder's sentences, so a saved setup always bootstraps. */
function judge(raw: unknown): { ok: true; block: CurveSetupBlock } | { ok: false; refusals: string[] } {
  const checked = validateCurveSetup(raw);
  if (!checked.ok) return checked;
  if (!LINEAGE_PATTERN.test(checked.block.id)) return { ok: false, refusals: [LINEAGE_SENTENCE] };
  if (checked.block.id === PLATFORM_DEFAULT_CURVE) return { ok: false, refusals: [RESERVED_SENTENCE] };
  // label and baseCurve are names shown in the Studio and the history: bounded as a workspace name is (NAME_MAX).
  const tooLong = (["label", "baseCurve"] as const).filter((k) => checked.block[k].length > NAME_MAX);
  if (tooLong.length > 0) return { ok: false, refusals: tooLong.map((k) => `the setup's "${k}" must be 1 to ${NAME_MAX} characters`) };
  try {
    buildCurveFromSetup(checked.block);
  } catch (err) {
    if (err instanceof CurveBuildError) return { ok: false, refusals: err.refusals };
    throw err;
  }
  return checked;
}

interface Listed {
  id: string;
  /** The setup's own id (the slot's lineageKey): the name a derived curve's base and the estimate route take (B2 ruling R9). */
  setupId: string;
  label: string;
  interpolation: string;
  dayCount: string;
  compounding: string;
  rows: readonly CurveInput[];
  active: boolean;
}

export function registerCurveSetupRoutes(router: Router, ctx: PlatformContext): void {
  const { store, workspaces: wsStore } = ctx;

  router.add("GET", "/api/workspaces/:id/curve-setups", (req) => {
    const head = wsStore.head(req.params.id ?? ""); // 404 for an unknown workspace
    const block = head.blocks.market.curveSetups;
    const setups: Listed[] = [];
    // A slot whose document is gone never takes the list down: it is skipped and named under `missing`
    // (left out when empty); readiness names an active one as an Error item.
    const missing: Array<{ id: string; problem: string }> = [];
    for (const slot of block?.setups ?? []) {
      let doc: CurveSetupBlock;
      try {
        doc = store.getDocument<CurveSetupBlock>("curve-setups", slot.current.id).doc;
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
        missing.push({ id: slot.current.id, problem: `the curve setup document "${slot.current.id}" is not in the store` });
        continue;
      }
      setups.push({
        id: slot.current.id,
        setupId: slot.lineageKey,
        label: doc.label,
        interpolation: doc.interpolation,
        dayCount: doc.dayCount,
        compounding: doc.compounding,
        rows: doc.inputs,
        active: block?.active === slot.current.id,
      });
    }
    return { kind: "json", value: missing.length > 0 ? { setups, missing } : { setups } };
  });

  router.add("GET", "/api/curve-setups/:docId", (req) => ({
    kind: "json",
    value: store.getDocument<CurveSetupBlock>("curve-setups", req.params.docId ?? "").doc,
  }));

  router.add("POST", "/api/workspaces/:id/curve-setups", (req) => {
    const workspaceId = req.params.id ?? "";
    wsStore.head(workspaceId); // 404 before the body is judged
    const body = bodyOf(req.json());
    const by = requireBy(body);
    const expectedRevision = requireExpectedRevision(body);
    const judged = judge(body.setup);
    if (!judged.ok) return refused(judged.refusals);
    const doc = judged.block;
    const id = curveSetupIdOf(doc);

    return wsStore.withLock([workspaceId], () => {
      const head = wsStore.head(workspaceId);
      assertWritable(head);
      if (head.revision !== expectedRevision) throw new RevisionConflict(workspaceId, expectedRevision, head.revision);

      // Append-only: identical content is the same document, so an existing id is reused as it stands.
      let meta: DocumentMeta;
      if (store.has("curve-setups", id)) {
        meta = store.getMeta("curve-setups", id);
      } else {
        try {
          meta = store.putDocument("curve-setups", id, doc, { label: doc.label, workspaceId });
        } catch (err) {
          if (!(err instanceof AlreadyExistsError)) throw err;
          meta = store.getMeta("curve-setups", id); // another request wrote the same bytes first
        }
      }

      const current = head.blocks.market.curveSetups;
      const slots = current?.setups ?? [];
      const existing = slots.find((s) => s.lineageKey === doc.id);
      if (existing !== undefined && existing.current.id === id) {
        // Saving what the slot already holds changes nothing: no revision, no history line.
        return { kind: "json", status: 200, value: { id, revision: head.revision } } as const;
      }
      const ref: DocRef = { collection: "curve-setups", id, contentHash: meta.contentHash, pinnedAt: new Date().toISOString() };
      const slot: CurveSetupSlot = { lineageKey: doc.id, current: ref };
      const setups = existing === undefined ? [...slots, slot] : slots.map((s) => (s === existing ? slot : s));
      // An edit of the active setup keeps it active: the pointer follows its slot to the new document.
      const active = current?.active !== undefined && existing !== undefined && current.active === existing.current.id ? id : current?.active;
      const curveSetups: CurveSetupsBlock = { setups, ...(active !== undefined ? { active } : {}) };
      const next: WorkspaceManifest = { ...head, blocks: { ...head.blocks, market: { ...head.blocks.market, curveSetups } } };
      const manifest = wsStore.commit(
        workspaceId,
        expectedRevision,
        by,
        existing === undefined
          ? { kind: "set-block", block: "market", op: "add", ref: { collection: "curve-setups", id } }
          : { kind: "set-block", block: "market", op: "set", ref: { collection: "curve-setups", id }, curveSetup: "edit" },
        next,
      );
      return { kind: "json", status: 201, value: { id, revision: manifest.revision } } as const;
    });
  });

  router.add("POST", "/api/workspaces/:id/curve-setups/:setupId/activate", (req) => {
    const workspaceId = req.params.id ?? "";
    const setupId = req.params.setupId ?? "";
    wsStore.head(workspaceId); // 404 before the body is judged
    const body = bodyOf(req.json());
    const by = requireBy(body);
    const expectedRevision = requireExpectedRevision(body);

    return wsStore.withLock([workspaceId], () => {
      const head = wsStore.head(workspaceId);
      assertWritable(head);
      if (head.revision !== expectedRevision) throw new RevisionConflict(workspaceId, expectedRevision, head.revision);
      const current = head.blocks.market.curveSetups;
      if (current === undefined || !current.setups.some((s) => s.current.id === setupId)) {
        throw notFound(`workspace "${workspaceId}" holds no curve setup "${setupId}"`);
      }
      if (current.active === setupId) return { kind: "json", value: { revision: head.revision } } as const;
      const next: WorkspaceManifest = {
        ...head,
        blocks: { ...head.blocks, market: { ...head.blocks.market, curveSetups: { ...current, active: setupId } } },
      };
      const manifest = wsStore.commit(
        workspaceId,
        expectedRevision,
        by,
        { kind: "set-block", block: "market", op: "set", ref: { collection: "curve-setups", id: setupId } },
        next,
      );
      return { kind: "json", value: { revision: manifest.revision } } as const;
    });
  });

  router.add("POST", "/api/workspaces/:id/curve-setups/deactivate", (req) => {
    const workspaceId = req.params.id ?? "";
    wsStore.head(workspaceId); // 404 before the body is judged
    const body = bodyOf(req.json());
    const by = requireBy(body);
    const expectedRevision = requireExpectedRevision(body);

    return wsStore.withLock([workspaceId], () => {
      const head = wsStore.head(workspaceId);
      assertWritable(head);
      if (head.revision !== expectedRevision) throw new RevisionConflict(workspaceId, expectedRevision, head.revision);
      const current = head.blocks.market.curveSetups;
      if (current === undefined || current.active === undefined) {
        throw conflict(`no curve setup is active in workspace "${workspaceId}"; there is nothing to deactivate`);
      }
      // The active key is left out, never null: the slot reads as it did before any activate.
      const { active, ...rest } = current;
      const next: WorkspaceManifest = { ...head, blocks: { ...head.blocks, market: { ...head.blocks.market, curveSetups: rest } } };
      const manifest = wsStore.commit(
        workspaceId,
        expectedRevision,
        by,
        { kind: "set-block", block: "market", op: "remove", ref: { collection: "curve-setups", id: active }, curveSetup: "deactivate" },
        next,
      );
      return { kind: "json", value: { revision: manifest.revision } } as const;
    });
  });

  router.add("POST", "/api/curve-setups/preview", (req) => {
    const raw = req.json<unknown>();
    const setup = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Body).setup : undefined;
    const checked = validateCurveSetup(setup);
    if (!checked.ok) return { kind: "json", status: 422, value: { ok: false, refusals: checked.refusals } };
    let built: ReturnType<typeof buildCurveFromSetup>;
    try {
      built = buildCurveFromSetup(checked.block);
    } catch (err) {
      if (err instanceof CurveBuildError) return { kind: "json", status: 422, value: { ok: false, refusals: err.refusals } };
      throw err;
    }
    const { curve, quoteTenors, warnings } = built;
    return {
      kind: "json",
      value: {
        ok: true,
        quoteNodes: quoteTenors.map((t) => ({ tenorMonths: Math.round(t * 12), zeroRate: curve.zeroRate(t), discountFactor: curve.discountFactor(t) })),
        denseCount: curve.t.length,
        warnings,
      },
    };
  });
}

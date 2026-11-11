/**
 * Workspace clone and re-apply routes (Studio A+E spec v3.1 Sections 2.3, 2.4 and 2.10):
 *
 *   POST /api/workspaces/:id/clone          copy, roll-forward, or supersede clone
 *   POST /api/workspaces/:id/market/reapply re-apply carried market definitions (ruling 17)
 *
 * Both take `by` and `expectedRevision` like every mutating workspace route. A clone answers
 * `{ manifest, readiness }`; readiness is the report of workspaces/readiness.ts for the new head.
 * A copy writes nothing to the source. A supersede clone is the one write that touches two
 * directories: the clone is written complete first, the source marked second, the flag cleared
 * third (see workspaces/clone.ts), both locks held in id order.
 */
import type { PlatformContext } from "../../context";
import { assertValidId } from "../../store/paths";
import { sha256Hex } from "../../store/store";
import { defaultCloneId, buildCloneManifest, hex4, writeClone, type CloneMode } from "../../workspaces/clone";
import { BLOCK_NAMES } from "../../workspaces/hashes";
import { computeReadiness } from "../../workspaces/readiness";
import { reapplyMarket } from "../../workspaces/reapply";
import {
  NAME_MAX,
  WORKSPACE_TYPES,
  assertWritable,
  productionUnique,
  requireBy,
  requireExpectedRevision,
  requireIsoDate,
} from "../../workspaces/rules";
import { standardAlcoSetup } from "../../workspaces/standardAlco";
import type { BlockName, SetupSlot, WorkspaceManifest, WorkspaceType } from "../../workspaces/types";
import { RevisionConflict } from "../../workspaces/workspaceStore";
import { conflict, unprocessable } from "../errors";
import type { Router } from "../router";

type Body = Record<string, unknown>;

function bodyOf(raw: unknown): Body {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw unprocessable("the request body must be a JSON object");
  return raw as Body;
}

export function registerWorkspaceCloneRoutes(router: Router, ctx: PlatformContext): void {
  const { store, workspaces: wsStore } = ctx;

  router.add("POST", "/api/workspaces/:id/clone", (req) => {
    const srcId = req.params.id ?? "";
    wsStore.head(srcId); // 404 for an unknown source before the body is judged
    const body = bodyOf(req.json());
    const by = requireBy(body);
    const expectedRevision = requireExpectedRevision(body);

    const mode = body.mode;
    if (mode !== "copy" && mode !== "roll-forward") {
      throw unprocessable(`"mode" must be "copy" or "roll-forward"`, { field: "mode" });
    }
    const cloneMode: CloneMode = mode;
    if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > NAME_MAX) {
      throw unprocessable(`"name" is required: a string of 1 to ${NAME_MAX} characters`, { field: "name" });
    }
    const name = body.name;
    let type: WorkspaceType | undefined;
    if (body.type !== undefined) {
      if (typeof body.type !== "string" || !WORKSPACE_TYPES.includes(body.type as WorkspaceType)) {
        throw unprocessable(`"type" must be one of ${WORKSPACE_TYPES.join(", ")}`, { field: "type" });
      }
      type = body.type as WorkspaceType;
    }
    if (!Array.isArray(body.blocks)) {
      throw unprocessable(`"blocks" is required: the clone checklist, an array of ${BLOCK_NAMES.join(", ")}`, { field: "blocks" });
    }
    const checklist: BlockName[] = [];
    for (const b of body.blocks) {
      if (typeof b !== "string" || !(BLOCK_NAMES as readonly string[]).includes(b)) {
        throw unprocessable(`"blocks" holds ${JSON.stringify(b)}; each entry must be one of ${BLOCK_NAMES.join(", ")}`, { field: "blocks" });
      }
      if (!checklist.includes(b as BlockName)) checklist.push(b as BlockName);
    }
    if (body.supersedeSource !== undefined && typeof body.supersedeSource !== "boolean") {
      throw unprocessable(`"supersedeSource" must be true or false`, { field: "supersedeSource" });
    }
    const supersedeSource = body.supersedeSource === true;
    let explicitId: string | undefined;
    if (body.id !== undefined) {
      if (typeof body.id !== "string") throw unprocessable(`"id" must be a string`, { field: "id" });
      explicitId = assertValidId(body.id);
    }
    let bodyCutoff: string | undefined;
    if (cloneMode === "copy") {
      if (body.cutoffDate !== undefined) {
        throw unprocessable(`a copy keeps the source's cut-off date; send no "cutoffDate" (a roll-forward moves it)`, { field: "cutoffDate" });
      }
    } else {
      bodyCutoff = requireIsoDate(body.cutoffDate, "cutoffDate");
    }
    if (supersedeSource && cloneMode !== "copy") {
      throw unprocessable(`"supersedeSource" applies to a copy at the same cut-off date; a roll-forward is a new month`, { field: "supersedeSource" });
    }

    const head0 = wsStore.head(srcId);
    const cutoffDate = cloneMode === "copy" ? head0.cutoffDate : bodyCutoff!;
    const now = new Date().toISOString();

    // The id is settled before the locks are taken so both can be claimed together; a race for it is a 409 below.
    let newId: string;
    if (explicitId !== undefined) {
      newId = explicitId;
    } else {
      newId = defaultCloneId(srcId, cloneMode, cutoffDate, now);
      for (let i = 1; wsStore.has(newId); i++) {
        if (i > 64) throw conflict(`no free default id for a clone of "${srcId}"; send an "id"`);
        newId = cloneMode === "roll-forward" ? `${defaultCloneId(srcId, cloneMode, cutoffDate, now)}-${hex4(srcId, `${now}#${i}`)}` : defaultCloneId(srcId, cloneMode, cutoffDate, `${now}#${i}`);
      }
    }

    return wsStore.withLock([srcId, newId], () => {
      const src = wsStore.head(srcId);
      if (src.revision !== expectedRevision) throw new RevisionConflict(srcId, expectedRevision, src.revision);
      if (wsStore.has(newId)) throw conflict(`workspace "${newId}" already exists; choose another id`);

      if (cloneMode === "roll-forward" && !(cutoffDate > src.cutoffDate)) {
        throw unprocessable(
          `"cutoffDate" ${cutoffDate} is not after the source's cut-off ${src.cutoffDate}; a roll-forward moves the date forward`,
          { field: "cutoffDate" },
        );
      }
      const cloneType: WorkspaceType = type ?? (cloneMode === "copy" ? "test" : "monthly");

      if (supersedeSource) {
        if (cloneType !== "production") {
          throw unprocessable(`"supersedeSource" applies to a Production clone; send "type": "production"`, { field: "supersedeSource" });
        }
        if (src.type !== "production") {
          throw unprocessable(`workspace "${srcId}" is ${src.type}, not Production; only a Production month is superseded by clone`, { field: "supersedeSource" });
        }
        if (src.status !== "active" && src.status !== "locked") {
          throw conflict(
            src.status === "superseded"
              ? `workspace "${srcId}" was already superseded by "${src.lineage.supersededBy ?? "(pending)"}"; correct that workspace instead`
              : `workspace "${srcId}" is ${src.status}; a Production month is superseded from an active or locked workspace`,
          );
        }
      } else if (cloneType === "production" && src.type === "production" && src.cutoffDate === cutoffDate && src.status !== "superseded") {
        throw conflict(
          `workspace "${srcId}" is the Production workspace for cut-off ${cutoffDate}; a Production clone at the same date ` +
            `is a correction and needs "supersedeSource": true, which marks "${srcId}" superseded`,
        );
      }

      // Uniqueness: the source is out of the count only when the same write supersedes it.
      const other = productionUnique(wsStore.list(), cloneType, cutoffDate, supersedeSource ? srcId : null);
      if (other) {
        throw conflict(
          `workspace "${other.id}" is already the Production workspace for cut-off ${cutoffDate}; a correction is a ` +
            `supersede clone of it, not a second Production workspace`,
        );
      }

      // The clash rule holds on clone: a Production workspace holds only documents dated at its cut-off.
      // `clashes` is append-only, so only a record whose document is still pinned in the block blocks (review B m4).
      if (cloneType === "production" && cloneMode === "copy") {
        const pinnedId = (block: "positions" | "market"): string | undefined =>
          block === "positions" ? src.blocks.positions.book?.id : src.blocks.market.snapshot?.id;
        const clash = src.clashes.find((c) => checklist.includes(c.block) && c.id === pinnedId(c.block));
        if (clash) {
          throw unprocessable(
            `${clash.block === "positions" ? "position book" : "market snapshot"} "${clash.id}" is dated ${clash.documentAsOf}, ` +
              `but a Production clone of "${srcId}" has cut-off ${cutoffDate}; a Production workspace holds only documents ` +
              `dated at its cut-off. Leave "${clash.block}" off the checklist, or clone into a Test workspace`,
            { field: "blocks", cutoffDate, documentAsOf: clash.documentAsOf },
          );
        }
      }

      // The Standard ALCO document first, as a blank workspace gets it: an append-only write that
      // leaves a harmless orphan if the manifest write fails; identical bytes are one document.
      const freshSetup = (): SetupSlot => {
        const setup = standardAlcoSetup(newId);
        const meta = store.has("run-setups", setup.id)
          ? store.getMeta("run-setups", setup.id)
          : store.putDocument("run-setups", setup.id, setup, { label: setup.name, workspaceId: newId });
        return {
          setupLineageId: `setup-${sha256Hex(JSON.stringify([newId, now])).slice(0, 8)}`,
          current: { collection: "run-setups", id: setup.id, contentHash: meta.contentHash, pinnedAt: now },
        };
      };

      const manifest: WorkspaceManifest = buildCloneManifest(src, {
        id: newId,
        name,
        type: cloneType,
        mode: cloneMode,
        cutoffDate,
        checklist,
        supersede: supersedeSource,
        now,
        freshSetup,
      });
      const written = writeClone(wsStore, src, manifest, by);
      return { kind: "json", status: 201, value: { manifest: written, readiness: computeReadiness(written, ctx, wsStore) } } as const;
    });
  });

  router.add("POST", "/api/workspaces/:id/market/reapply", (req) => {
    const id = req.params.id ?? "";
    wsStore.head(id); // 404 for an unknown workspace before the body is judged
    const body = bodyOf(req.json());
    const by = requireBy(body);
    const expectedRevision = requireExpectedRevision(body);

    return wsStore.withLock([id], () => {
      const head = wsStore.head(id);
      assertWritable(head);
      if (head.revision !== expectedRevision) throw new RevisionConflict(id, expectedRevision, head.revision);
      const market = head.blocks.market;
      if (market.carried.length === 0) {
        throw unprocessable(`workspace "${id}" carries no market definitions; re-apply follows a roll-forward that held derived markets`, { field: "market" });
      }
      if (market.snapshot === null) {
        throw unprocessable(`set the base market snapshot first: carried definitions derive on the new month's base`, { field: "market" });
      }
      const result = reapplyMarket(store, head, new Date().toISOString());
      if (result.change === null) return { kind: "json", value: head } as const;
      const next = wsStore.commit(id, head.revision, by, result.change, { ...head, blocks: { ...head.blocks, market: result.market } });
      return { kind: "json", value: next } as const;
    });
  });
}

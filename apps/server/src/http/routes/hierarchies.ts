/**
 * Hierarchies and mapping (tag route).
 *
 *   GET  /api/hierarchies                  listing (the meta rows, verbatim)
 *   GET  /api/hierarchies/sources/:bookId  the tags a book offers as a source, with their values
 *   GET  /api/hierarchies/:id              the stored hierarchy, verbatim
 *   POST /api/hierarchies                  { hierarchy, bookId } -> 201 | 200 (identical re-save) | 409 | 422
 *   POST /api/hierarchies/:id/apply        { bookId } -> 201 | 200 (already applied) | 409 | 422
 *
 * A hierarchy maps one authored, single-valued tag into a tree of named
 * levels. Save checks it against ONE book (the map must be total over the
 * tag's values) and stores the canonical form append-only. Apply writes a NEW
 * book, `<bookId>--<hierarchyId>`, whose positions carry one more tag per
 * level; the source book is untouched. Apply writes tags only and sums
 * nothing: the new book's intake statistics are the source book's stored block
 * copied verbatim, because tags move no family, side or notional. The server
 * owns every rule here; Studio shows what it serves and adds no figure.
 * All lists are built with for-of loops; the only counts are array lengths.
 */
import { validateDimensions, type PortfolioSpec } from "@alm/engine";
import type { PlatformContext } from "../../context";
import {
  checkAgainstBook,
  parseHierarchy,
  retagBook,
  retaggedBookId,
  sourceDimensionsOf,
  tagId,
  validateHierarchy,
  type Hierarchy,
} from "../../hierarchies/hierarchy";
import { ID_PATTERN, assertValidId } from "../../store/paths";
import { serializeDocument, sha256Hex } from "../../store/store";
import { conflict, unprocessable } from "../errors";
import { mirrorBestEffort, type Router } from "../router";
import { putBook } from "./portfolios";

const SAVE_USAGE = "POST /api/hierarchies takes { hierarchy, bookId }";
const APPLY_USAGE = "POST /api/hierarchies/:id/apply takes { bookId }";

/** Code-unit order, the same comparator hierarchy.ts uses. */
function asc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function registerHierarchyRoutes(router: Router, ctx: PlatformContext): void {
  const { store } = ctx;

  const loadBook = (bookId: string): PortfolioSpec =>
    store.getDocument<PortfolioSpec>("portfolios", assertValidId(bookId)).doc;

  router.add("GET", "/api/hierarchies", () => ({ kind: "json", value: store.listMeta("hierarchies") }));

  router.add("GET", "/api/hierarchies/sources/:bookId", (req) => ({
    kind: "json",
    value: sourceDimensionsOf(loadBook(req.params.bookId ?? "")),
  }));

  router.add("GET", "/api/hierarchies/:id", (req) => ({
    kind: "json",
    value: store.getDocument("hierarchies", assertValidId(req.params.id ?? "")).doc,
  }));

  router.add("POST", "/api/hierarchies", (req) => {
    const body = req.json<unknown>();
    if (!isPlainObject(body)) throw unprocessable(SAVE_USAGE);
    for (const k of Object.keys(body)) {
      if (k !== "hierarchy" && k !== "bookId") {
        throw unprocessable(`unknown field ${JSON.stringify(k)} in the request body; send { hierarchy, bookId }`);
      }
    }
    if (typeof body.bookId !== "string") throw unprocessable(SAVE_USAGE);
    const bookId = body.bookId;

    const h: Hierarchy = parseHierarchy(body.hierarchy);
    const structural = validateHierarchy(h);
    if (structural.length > 0) {
      throw unprocessable(
        `hierarchy "${h.id}" rejected: ${structural.length} problem(s); every problem is listed`,
        { problems: structural, unmapped: [] },
      );
    }
    const book = loadBook(bookId);
    const fit = checkAgainstBook(h, book);
    if (fit.problems.length > 0) {
      throw unprocessable(
        `hierarchy "${h.id}" does not fit book "${book.id}": ${fit.problems.length} problem(s); every problem is listed`,
        { problems: fit.problems, unmapped: fit.unmapped },
      );
    }

    if (store.has("hierarchies", h.id)) {
      const meta = store.getMeta("hierarchies", h.id);
      if (meta.contentHash === sha256Hex(serializeDocument(h))) {
        return { kind: "json", status: 200, value: { outcome: "unchanged", ...meta } };
      }
      throw conflict(
        `hierarchy "${h.id}" already exists with different content (the store is append-only); save it under a new id`,
      );
    }
    const meta = store.putDocument("hierarchies", h.id, h, {
      label: h.label,
      kind: h.kind,
      sourceDimension: h.sourceDimension,
      checkedBookId: book.id,
    });
    return { kind: "json", status: 201, value: { outcome: "created", ...meta } };
  });

  router.add("POST", "/api/hierarchies/:id/apply", (req) => {
    const body = req.json<unknown>();
    if (!isPlainObject(body)) throw unprocessable(APPLY_USAGE);
    for (const k of Object.keys(body)) {
      if (k !== "bookId") throw unprocessable(`${APPLY_USAGE}; got unknown field ${JSON.stringify(k)}`);
    }
    if (typeof body.bookId !== "string" || !ID_PATTERN.test(body.bookId)) {
      throw unprocessable("bookId must be a store id string");
    }
    const bookId = body.bookId;

    // 1 and 2: the hierarchy, then the book and its stored meta.
    const h = store.getDocument<Hierarchy>("hierarchies", assertValidId(req.params.id ?? "")).doc;
    // Defence in depth: a stored hierarchy that no longer passes its own rules is not applied.
    const structural = validateHierarchy(h);
    if (structural.length > 0) {
      throw unprocessable(
        `stored hierarchy "${h.id}" is invalid: ${structural.length} problem(s); every problem is listed`,
        { problems: structural, unmapped: [] },
      );
    }
    const book = loadBook(bookId);
    const sourceMeta = store.getMeta("portfolios", bookId);

    // 3: the book-level checks (declared, single-valued, total).
    const fit = checkAgainstBook(h, book);
    if (fit.problems.length > 0) {
      throw unprocessable(
        `hierarchy "${h.id}" does not fit book "${book.id}": ${fit.problems.length} problem(s); every problem is listed`,
        { problems: fit.problems, unmapped: fit.unmapped },
      );
    }

    // 4: a tag this hierarchy would write must not already be declared.
    const declared = new Set((book.taxonomy?.dimensions ?? []).map((d) => d.id));
    for (const level of h.levels) {
      const t = tagId(h.id, level.id);
      if (declared.has(t)) {
        throw unprocessable(
          `book "${book.id}" already declares tag "${t}"; hierarchy "${h.id}" has been applied to it already, ` +
            "or another tag holds that id",
        );
      }
    }

    // 5: a source tag that no position carries would tag nothing.
    const source = sourceDimensionsOf(book).dimensions.find((d) => d.id === h.sourceDimension);
    if (source === undefined || !source.carried) {
      throw unprocessable(
        `no position of book "${book.id}" carries tag "${h.sourceDimension}", so hierarchy "${h.id}" would tag nothing`,
      );
    }

    // 6: the composed id must be a store id.
    const newId = retaggedBookId(bookId, h.id);
    if (!ID_PATTERN.test(newId)) {
      throw unprocessable(
        `the re-tagged book id "${newId}" is ${newId.length} characters; a store id is at most 64, ` +
          `so apply hierarchy "${h.id}" to a book with a shorter id or save the hierarchy under a shorter id`,
      );
    }

    // 7 and 8: build the re-tagged book and check only what apply changes, the dimension bags and the taxonomy
    // (rules D1 to D4). The import intake is not run: apply touches no term (before Studio slice S3a-1 the intake
    // also refused the swap, cd and commitment types a seeded book may hold).
    const spec = retagBook(h, book);
    const dimensionProblems = validateDimensions(spec);
    if (dimensionProblems.length > 0) {
      const problems: string[] = [];
      for (const d of dimensionProblems) {
        problems.push(d.positionId !== undefined ? `${d.rule} position "${d.positionId}": ${d.message}` : `${d.rule}: ${d.message}`);
      }
      throw unprocessable(
        `re-tagged book failed the dimension rules: ${problems.length} problem(s); every problem is listed`,
        { problems, unmapped: [] },
      );
    }
    const untaggedPositionIds: string[] = [];
    for (const p of book.positions) {
      if (p.dimensions?.[h.sourceDimension] === undefined) untaggedPositionIds.push(p.id);
    }
    untaggedPositionIds.sort(asc);

    const result = (status: number, outcomeWord: "created" | "unchanged", contentHash: string) => ({
      kind: "json" as const,
      status,
      value: {
        outcome: outcomeWord,
        id: newId,
        label: spec.label,
        asOf: spec.asOf,
        positionCount: spec.positions.length,
        contentHash,
        sourceBookId: bookId,
        hierarchyId: h.id,
        taxonomyId: spec.taxonomy?.id ?? null,
        tags: h.levels.map((level) => tagId(h.id, level.id)),
        untaggedPositionIds,
      },
    });

    // 9: the composed id is held already.
    if (store.has("portfolios", newId)) {
      const held = store.getMeta("portfolios", newId);
      if (held.sourceBookId !== bookId || held.hierarchyId !== h.id) {
        throw conflict(
          `book "${newId}" already exists and was not written by applying hierarchy "${h.id}" to book "${bookId}"; ` +
            "save the hierarchy under another id",
        );
      }
      if (held.contentHash === sha256Hex(serializeDocument(spec))) {
        return result(200, "unchanged", held.contentHash);
      }
      throw conflict(
        `book "${newId}" already exists with different content (the store is append-only); ` +
          `the source book or hierarchy "${h.id}" changed after it was applied`,
      );
    }

    // 10: write the new book; the source book's stored intake block is copied verbatim.
    const intake = sourceMeta.intake as Record<string, unknown> | undefined;
    const meta = putBook(store, spec, intake, { sourceBookId: bookId, hierarchyId: h.id });
    // After the store write: the catalog and lineage reads answer for this document at once (best effort).
    mirrorBestEffort(ctx, "portfolios", newId);
    return result(201, "created", meta.contentHash);
  });
}

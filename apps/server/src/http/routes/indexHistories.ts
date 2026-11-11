/**
 * Index history routes.
 *
 *   POST /api/index-histories/import  raw .csv or .xlsx bytes, X-Filename header, ?unit=percent|decimal (required),
 *                                     ?label= (optional). 201 { id, created: true, history } for a new document,
 *                                     200 { id, created: false, history } when the store already holds that content,
 *                                     422 { error, refusals } naming the row or the month. A 201 or 200 also carries
 *                                     partialLastMonth { month, lastDay } when a daily file ends before its last
 *                                     month's last weekday; it is not stored (B3b follow-up item 6).
 *   GET  /api/index-histories/:id     one stored document, verbatim.
 *
 * The store is append-only and the id is the content (`ih-<16 hex>`), so a re-import of the same series is the same
 * document; a corrected series is a new id, and the index is pointed at it by a set-index-history op. Not workspace-
 * scoped and not mirrored: a history reaches a run only through an index of a market the run reads.
 */
import { indexHistoryIdOf, type IndexHistory } from "@alm/engine";
import type { PlatformContext } from "../../context";
import { parseIndexHistoryFile } from "../../intake/indexHistory";
import { AlreadyExistsError, type FileStore } from "../../store/store";
import { badRequest } from "../errors";
import type { RouteResult, Router } from "../router";

export function putIndexHistory(store: FileStore, history: IndexHistory): { id: string; created: boolean } {
  const id = indexHistoryIdOf(history);
  if (store.has("index-histories", id)) return { id, created: false };
  try {
    store.putDocument("index-histories", id, history, { label: history.label, fileName: history.source.fileName });
    return { id, created: true };
  } catch (err) {
    if (err instanceof AlreadyExistsError) return { id, created: false }; // another request wrote the same bytes first
    throw err;
  }
}

/** A refused file: the typed error body, plus the sentences at the top level (the derived-curves shape). */
function refused(refusals: string[]): RouteResult {
  return {
    kind: "json",
    status: 422,
    value: { error: { code: "validation", message: refusals.join("; "), detail: { refusals } }, refusals },
  };
}

export function registerIndexHistoryRoutes(router: Router, ctx: PlatformContext): void {
  const { store } = ctx;

  router.add("POST", "/api/index-histories/import", (req) => {
    const filename = req.raw.headers["x-filename"];
    if (typeof filename !== "string" || filename.length === 0) throw badRequest("missing X-Filename header (the history file's original name)");
    if (req.body.length === 0) throw badRequest("empty body; expected the raw bytes of a .csv or .xlsx file");
    const parsed = parseIndexHistoryFile(req.body, filename, { unit: req.query.get("unit"), label: req.query.get("label") });
    if (!parsed.ok) return refused(parsed.refusals);
    const { id, created } = putIndexHistory(store, parsed.history);
    const flag = parsed.partialLastMonth === undefined ? {} : { partialLastMonth: parsed.partialLastMonth };
    return { kind: "json", status: created ? 201 : 200, value: { id, created, history: parsed.history, ...flag } };
  });

  router.add("GET", "/api/index-histories/:id", (req) => ({
    kind: "json",
    value: store.getDocument<IndexHistory>("index-histories", req.params.id ?? "").doc,
  }));
}

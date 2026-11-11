/**
 * Index histories at launch. The ids a run reads come from the engine
 * (indexHistoryIdsRead: the parents of the lagged formulas of the read closure, sorted by id and distinct). The setup
 * compile reads each as stored bytes, checks the content still hashes to its id, and pins it as `indexHistory:<id>`;
 * the run submission reads the same bytes under that pin and attaches the documents to the run request. A missing
 * document is a 422 and moved bytes are a 409, as readDerivedCurve answers; a run never falls back to a flat fill in
 * place of a history.
 *
 *   readIndexHistory      one history by id, as stored bytes: 422 when missing or unreadable, 409 when moved
 *   storedIndexHistories  the histories of a list of ids the store holds, in the list's order (tolerant: an id the
 *                         store lacks is left out, so the engine's run check names the index that needs it)
 *   missingIndexHistory   the sentence a launch answers when a history the run reads is not in the store
 */
import { indexHistoryIdOf, validateIndexHistory, type IndexHistory, type IndexHistoryEntry } from "@alm/engine";
import { conflict, unprocessable } from "../http/errors";
import { NotFoundError, sha256Hex, type FileStore } from "../store/store";
import type { DocRef } from "./types";

export function missingIndexHistory(id: string): string {
  return `The index history "${id}" is not in the store; import it again on Market > Rate indices.`;
}

export function readIndexHistory(store: FileStore, id: string): { ref: DocRef; entry: IndexHistoryEntry } {
  let bytes: Buffer;
  try {
    bytes = store.getDocumentBytes("index-histories", id);
  } catch (err) {
    if (err instanceof NotFoundError) throw unprocessable(missingIndexHistory(id), { field: "market.rateIndices" });
    throw err;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    doc = undefined;
  }
  const bad = doc === undefined ? ["its bytes are not JSON"] : validateIndexHistory(doc);
  if (bad.length > 0) throw unprocessable(`The index history "${id}" is not a readable index history: ${bad.join("; ")}`, { refusals: bad });
  const actual = indexHistoryIdOf(doc as IndexHistory);
  if (actual !== id) throw conflict(`pin indexHistory "${id}" moved: its id names its content, but its bytes now hash to "${actual}"`);
  return { ref: { collection: "index-histories", id, contentHash: sha256Hex(bytes), pinnedAt: new Date().toISOString() }, entry: { id, history: doc as IndexHistory } };
}

export function storedIndexHistories(store: FileStore, ids: readonly string[]): IndexHistoryEntry[] {
  return ids.filter((id) => store.has("index-histories", id)).map((id) => ({ id, history: store.getDocument<IndexHistory>("index-histories", id).doc }));
}

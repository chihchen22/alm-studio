/**
 * Index history client: one function per route of
 * apps/server/src/http/routes/indexHistories.ts, over the shared transport of ./client. The reply shapes are
 * written by hand from that route; the document is the engine's own IndexHistory, imported rather than copied.
 *
 * A refused file (422 whose body carries `refusals`) is a reply, `{ ok: false, refusals }`, as a refused curve
 * setup is; every other failure is the ApiError the shared transport raises. Nothing here re-derives a value.
 */
import type { IndexHistory, IndexHistoryUnit } from "@alm/engine";
import { apiBase, apiEnc as enc, apiParseError as parseError, apiRequest as request } from "./client";

/** A daily file's last month when its last dated day is before that month's last weekday (not stored; B3b follow-up item 6). */
export interface PartialLastMonth {
  month: string;
  lastDay: string;
}
export type ImportIndexHistoryResult =
  | { ok: true; id: string; created: boolean; history: IndexHistory; partialLastMonth?: PartialLastMonth }
  | { ok: false; refusals: string[] };

/** The `refusals` list of a 422 body, when it carries one as a list of sentences; otherwise null. */
function refusalsOf(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  const r = (body as { refusals?: unknown }).refusals;
  return Array.isArray(r) && r.every((s) => typeof s === "string") ? (r as string[]) : null;
}

/**
 * POST /api/index-histories/import: the raw bytes of a .csv or .xlsx file under its original name, with the
 * declared unit and an optional label. 201 for a new document, 200 when the store already holds that content.
 */
export async function importIndexHistory(bytes: ArrayBuffer, filename: string, opts: { unit: IndexHistoryUnit; label?: string }): Promise<ImportIndexHistoryResult> {
  const query = `unit=${enc(opts.unit)}${opts.label === undefined ? "" : `&label=${enc(opts.label)}`}`;
  const res = await fetch(`${apiBase}/index-histories/import?${query}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "X-Filename": filename },
    body: bytes,
  });
  if (res.status === 422) {
    let parsed: unknown;
    try {
      parsed = await res.clone().json();
    } catch {
      // Not JSON: fall through to the ApiError below.
    }
    const refusals = refusalsOf(parsed);
    if (refusals !== null) return { ok: false, refusals };
  }
  if (!res.ok) throw await parseError(res);
  const reply = (await res.json()) as { id: string; created: boolean; history: IndexHistory; partialLastMonth?: PartialLastMonth };
  const flag = reply.partialLastMonth === undefined ? {} : { partialLastMonth: reply.partialLastMonth };
  return { ok: true, id: reply.id, created: reply.created, history: reply.history, ...flag };
}

/** GET /api/index-histories/:id: one stored document, verbatim. */
export function getIndexHistory(id: string): Promise<IndexHistory> {
  return request<IndexHistory>(`/index-histories/${enc(id)}`);
}

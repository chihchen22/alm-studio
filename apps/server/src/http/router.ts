/**
 * Minimal HTTP router over node:http (zero new dependencies). Routes are
 * (method, path-pattern) pairs; ":name" segments capture. Handlers return a
 * RouteResult or throw; thrown values map through toHttpError to the typed
 * error body. Bodies are read fully (JSON or raw bytes) with a size cap large
 * enough for a 100k-position PortfolioSpec.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PlatformContext } from "../context";
import { syncDocumentToDb } from "../db/ingest";
import type { Collection } from "../store/paths";
import { errorBody, toHttpError, badRequest, unprocessable, type HttpError } from "./errors";

/** 512 MB: a 100k-position JSON book is tens-to-hundreds of MB (design 9). */
export const MAX_BODY_BYTES = 512 * 1024 * 1024;

export interface RouteRequest {
  raw: IncomingMessage;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Raw body bytes (empty buffer when none). */
  body: Buffer;
  /** Parse the body as JSON or throw a 400. */
  json<T = unknown>(): T;
}

export type RouteResult =
  | { kind: "json"; status?: number; value: unknown }
  | { kind: "bytes"; status?: number; contentType: string; value: Buffer; headers?: Record<string, string> }
  | { kind: "stream"; handle: (res: ServerResponse) => void }
  | { kind: "empty"; status?: number };

export type RouteHandler = (req: RouteRequest) => RouteResult | Promise<RouteResult>;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

/** Wrap an engine/compiler call: any refusal surfaces as 422, message verbatim. */
export function validated<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error) throw unprocessable(err.message);
    throw unprocessable(String(err));
  }
}

/**
 * Mirror one just-stored document into the platform database, best effort. An import route calls this AFTER
 * the store write succeeded: the file store is the system of record and the mirror is derived, so a mirror
 * failure (a locked or unreadable database, a divergent row) must never turn a saved import into a 500. The
 * failure is logged on one line naming the collection and id; the next boot sync reconciles or refuses it.
 * Never rethrows. Synchronous, like the store write it follows.
 */
export function mirrorBestEffort(ctx: Pick<PlatformContext, "store">, collection: Collection, id: string): void {
  try {
    syncDocumentToDb(ctx, collection, id);
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ");
    console.error(`platform: mirror sync failed for ${collection}/${id} (the document is stored; the next boot sync reconciles or refuses): ${why}`);
  }
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): void {
    this.routes.push({ method, segments: pattern.split("/").filter((s) => s !== ""), handler });
  }

  /** Match a request; null when no route fits (caller falls through to static). */
  match(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
    const parts = pathname.split("/").filter((s) => s !== "");
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(":")) {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
        } else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }

  /** Full request cycle: body read, dispatch, serialization, error mapping. */
  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const matched = this.match(req.method ?? "GET", url.pathname);
    if (!matched) return false;

    try {
      const body = await readBody(req);
      const routeReq: RouteRequest = {
        raw: req,
        params: matched.params,
        query: url.searchParams,
        body,
        json: <T>(): T => {
          if (body.length === 0) throw badRequest("request body is empty; expected JSON");
          try {
            return JSON.parse(body.toString("utf8")) as T;
          } catch (err) {
            throw badRequest(
              `request body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      };
      const result = await matched.handler(routeReq);
      writeResult(res, result);
    } catch (err) {
      writeError(res, toHttpError(err));
    }
    return true;
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(badRequest(`request body exceeds the ${MAX_BODY_BYTES}-byte cap`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function writeResult(res: ServerResponse, result: RouteResult): void {
  switch (result.kind) {
    case "json": {
      const payload = `${JSON.stringify(result.value)}\n`;
      res.writeHead(result.status ?? 200, { "content-type": "application/json; charset=utf-8" });
      res.end(payload);
      return;
    }
    case "bytes": {
      res.writeHead(result.status ?? 200, {
        "content-type": result.contentType,
        ...(result.headers ?? {}),
      });
      res.end(result.value);
      return;
    }
    case "stream":
      result.handle(res);
      return;
    case "empty":
      res.writeHead(result.status ?? 204);
      res.end();
      return;
  }
}

export function writeError(res: ServerResponse, err: HttpError): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(err.status, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(errorBody(err))}\n`);
}

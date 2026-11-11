/**
 * Test harness: boot a full platform server on an ephemeral 127.0.0.1 port over
 * a scratch store, with small typed HTTP helpers. Every test gets a fresh
 * store; nothing touches the real var/store.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMarketSnapshot } from "@alm/kernel";
import type { MarketSnapshot } from "@alm/kernel";
import { repoRoot, type PlatformConfig } from "../config";
import { startPlatformServer, type PlatformServer } from "../server";
import { defaultDbPath, openPlatformDb } from "../db/database";
import { syncStoreToDb } from "../db/ingest";
import { FileStore } from "../store/store";

export interface TestPlatform {
  platform: PlatformServer;
  base: string;
  storeRoot: string;
  close(): Promise<void>;
}

export function scratchConfig(storeRoot?: string): PlatformConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    storeRoot: storeRoot ?? mkdtempSync(join(tmpdir(), "alm-platform-test-")),
    maxConcurrent: 1,
    repoRoot: repoRoot(),
  };
}

export async function bootTestPlatform(storeRoot?: string): Promise<TestPlatform> {
  const config = scratchConfig(storeRoot);
  const platform = await startPlatformServer(config);
  return {
    platform,
    base: `http://127.0.0.1:${platform.port}`,
    storeRoot: config.storeRoot,
    close: () => platform.close(),
  };
}

/**
 * Create the platform database from the store as it stands, the way a boot, seed or migrate sync does, so a
 * route's mirror hook has a database to advance. A test whose store was never seeded calls this before the
 * write under test; the hooks leave a store with no database alone by design.
 */
export function mirrorStoreNow(storeRoot: string): void {
  const db = openPlatformDb(defaultDbPath(storeRoot));
  try {
    syncStoreToDb(new FileStore(storeRoot), db);
  } finally {
    db.close();
  }
}

/** Open the Catalog's lazy read connection now, so a later 200 proves a row committed by another connection is visible. */
export async function warmCatalog(base: string): Promise<void> {
  const r = await api(base, "GET", "/api/catalog/portfolios");
  if (r.status !== 200) throw new Error(`warmCatalog: GET /api/catalog/portfolios answered ${r.status}`);
}

export interface HttpReply<T = unknown> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
}

export async function api<T = unknown>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<HttpReply<T>> {
  const payload: BodyInit | undefined =
    body === undefined
      ? undefined
      : typeof body === "string"
        ? body
        : body instanceof Uint8Array
          ? (body as unknown as BodyInit)
          : JSON.stringify(body);
  const res = await fetch(`${base}${path}`, {
    method,
    ...(payload !== undefined
      ? { body: payload, headers: { "content-type": "application/json", ...(headers ?? {}) } }
      : { headers: headers ?? {} }),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(text);
  } catch {
    // non-JSON payloads (CSV, streams) stay in .text
  }
  return { status: res.status, body: parsed as T, text, headers: res.headers };
}

export async function loadTestMarket(): Promise<MarketSnapshot> {
  return loadMarketSnapshot(
    join(repoRoot(), "packages", "kernel", "public", "market_public.json"),
  );
}

/** Poll until predicate or timeout; polling an async status endpoint. */
export async function waitFor<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await fn();
  while (!pred(last)) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms; last value ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

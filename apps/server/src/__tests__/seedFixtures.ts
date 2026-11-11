/**
 * Temporary-store helpers for the seed staleness tests. Every store
 * here lives under the OS temp directory; nothing touches var/store.
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { vanillaScenarios } from "@alm/data";
import { repoRoot } from "../config";
import { FileStore, serializeDocument, sha256Hex } from "../store/store";
import { buildDemoBalancePlan, SEED_IDS, seedStore } from "../../scripts/seed-store";

/** A freshly seeded temporary store (it carries a platform.db). */
export async function seededTemplate(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "alm-seed-template-"));
  await seedStore(new FileStore(root), repoRoot());
  return root;
}

/**
 * Copy a store into a new temporary directory, leaving platform.db and its WAL
 * files behind, so a planted document never meets a database that already pins
 * today's hash (the author's store pins the OLD hash, which is what a copy
 * without a database reproduces on its first default seed).
 */
export function copyStoreWithoutDb(from: string, prefix: string): string {
  const to = mkdtempSync(join(tmpdir(), prefix));
  cpSync(from, to, { recursive: true, filter: (src) => !basename(src).startsWith("platform.db") });
  return to;
}

/** Rewrite a stored document and its meta so the pair is self-consistent. */
function rewrite(root: string, collection: "scenario-slates" | "coa", id: string, doc: unknown, meta: Record<string, unknown>): string {
  const store = new FileStore(root);
  const bytes = serializeDocument(doc);
  const hash = sha256Hex(bytes);
  writeFileSync(store.paths.documentPath(collection, id), bytes);
  writeFileSync(store.paths.metaPath(collection, id), serializeDocument({ ...meta, contentHash: hash }));
  return hash;
}

/**
 * The author's real case: the vanilla slate as seeded before W5-D2, carrying the
 * builder's SM200/SM100 down-shock ids. Returns the planted document's hash.
 */
export function plantStaleVanillaSlate(root: string): string {
  const store = new FileStore(root);
  const id = SEED_IDS.vanillaSlate;
  const label = store.getDocument<{ label: string }>("scenario-slates", id).doc.label;
  const meta = store.getMeta("scenario-slates", id);
  return rewrite(root, "scenario-slates", id, { id, label, scenarios: vanillaScenarios(SEED_IDS.vanillaAssumptions) }, meta);
}

/** A document imported over a seeded id: changed bytes, and a meta with no `seeded` flag. */
export function plantImportedCoa(root: string): string {
  const store = new FileStore(root);
  const id = SEED_IDS.demoCoa;
  const doc = store.getDocument<Record<string, unknown>>("coa", id).doc;
  const meta: Record<string, unknown> = { ...store.getMeta("coa", id) };
  delete meta.seeded;
  return rewrite(root, "coa", id, { ...doc, importedNote: "imported over a seeded id" }, meta);
}

/** Every file (by SHA-256) and every directory (as "dir") under root, keyed by relative path. */
export function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const rel = relative(root, p);
      if (statSync(p).isDirectory()) {
        out.set(`${rel}/`, "dir");
        walk(p);
      } else {
        out.set(rel, sha256Hex(readFileSync(p)));
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Make sure the demo base balance plan is in the store. The seed
 * writes it from slice 4; until then (and on any store seeded before) this puts
 * the builder's own document there with the seed's meta. A no-op when it is there.
 */
export function ensureDemoBalancePlan(store: FileStore): void {
  const plan = buildDemoBalancePlan();
  if (store.has("plans", plan.id)) return;
  store.putDocument("plans", plan.id, plan, {
    label: plan.label,
    asOf: plan.asOf,
    targetCount: plan.targets.length,
    seeded: true,
  });
}

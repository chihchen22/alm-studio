/**
 * The server's extension registry. Core code names only its own seed profiles ("demo", "starter", "learn"); a pack loaded at
 * startup (src/companion.ts, the one import point) adds its seed profiles and its workspace readiness rules here.
 * With nothing registered every read below returns the core behaviour alone.
 */
import type { CurveDefaultStamp } from "@alm/engine/src/contracts/curveSetup";
import type { SeedDocument } from "../scripts/seed-store";
import type { FileStore } from "./store/store";
import type { WorkspaceStore } from "./workspaces/workspaceStore";

/** The core seed profile: the demo catalogue. */
export const CORE_SEED_PROFILE = "demo";

/**
 * The second core profile: the demo catalogue's documents and no workspace, so a
 * newcomer's first screen offers the three start choices and no seeded workspace can read Error.
 */
export const STARTER_SEED_PROFILE = "starter";

/**
 * The third core profile: the learn kit's store (`npm run learn`). It writes the starter's
 * documents exactly and no workspace; the kit then makes the finished analysis, the deposit desk's workspace and one
 * run of every demo through the Studio's own calls (apps/server/scripts/seed-learn.ts).
 */
export const LEARN_SEED_PROFILE = "learn";

/** The core profiles that write the demo catalogue's documents and no workspace at seed time. */
export const NO_WORKSPACE_PROFILES: readonly string[] = [STARTER_SEED_PROFILE, LEARN_SEED_PROFILE];

/** A seed profile a pack adds: the documents it writes in place of the demo plan, and the workspaces it authors. */
export interface SeedProfileEntry {
  id: string;
  /** Every document the profile writes, in write order. Pure over the repository, as the demo plan is. */
  plan(repoRoot: string): Promise<SeedDocument[]>;
  /** The workspaces the profile authors, written before the generic workspace rules run; returns the ids created. */
  seedWorkspaces(store: FileStore, workspaces: WorkspaceStore): string[] | Promise<string[]>;
}

/**
 * A readiness rule on a workspace's base curve: when `appliesTo` holds for the workspace id and its market builds,
 * `problem` reads the stamp of the market the launch would pin and returns the Curves item's Error text, or null.
 */
export interface CurveReadinessRule {
  id: string;
  appliesTo(workspaceId: string): boolean;
  problem(input: { workspaceId: string; pinnedMarketId: string; launchedMarketId: string; stamp: CurveDefaultStamp; builds: string }): string | null;
}

const profiles = new Map<string, SeedProfileEntry>();
const curveRules = new Map<string, CurveReadinessRule>();

export function registerSeedProfile(entry: SeedProfileEntry): void {
  if (entry.id === CORE_SEED_PROFILE || NO_WORKSPACE_PROFILES.includes(entry.id) || profiles.has(entry.id)) throw new Error(`seed profile "${entry.id}" is already registered`);
  profiles.set(entry.id, entry);
}

/** The profiles ALM_SEED_PROFILE may name: the three core ones first, then the registered ones in registration order. */
export function seedProfileIds(): string[] {
  return [CORE_SEED_PROFILE, ...NO_WORKSPACE_PROFILES, ...profiles.keys()];
}

/** A registered profile; throws naming the profiles there are when `id` is neither the core one nor registered. */
export function seedProfileEntry(id: string): SeedProfileEntry {
  const entry = profiles.get(id);
  if (entry === undefined) throw new Error(`seed: no seed profile "${id}" is registered; known: ${seedProfileIds().map((p) => `"${p}"`).join(", ")}`);
  return entry;
}

export function registerCurveReadinessRule(rule: CurveReadinessRule): void {
  if (curveRules.has(rule.id)) throw new Error(`curve readiness rule "${rule.id}" is already registered`);
  curveRules.set(rule.id, rule);
}

/** The registered curve rules that apply to one workspace, in registration order. */
export function curveReadinessRulesFor(workspaceId: string): CurveReadinessRule[] {
  return [...curveRules.values()].filter((r) => r.appliesTo(workspaceId));
}

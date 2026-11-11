/**
 * Platform configuration. Environment variables with
 * defaults; no config file this window.
 *
 *   ALM_PLATFORM_PORT            default 8787
 *   ALM_PLATFORM_STORE           default <repo>/var/store (gitignored)
 *   ALM_PLATFORM_MAX_CONCURRENT  default 1
 *   ALM_SEED_PROFILE default demo; a loaded pack may register more profiles (src/registry.ts)
 *
 * The bind host is NOT configurable: 127.0.0.1 is a standing constraint
 * (no deploy, no public surface).
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedProfileIds } from "./registry";

export const BIND_HOST = "127.0.0.1";

/** A seed profile id: "demo", the core catalogue, or one a loaded pack registered (src/registry.ts). */
export type SeedProfile = string;

export interface PlatformConfig {
  host: typeof BIND_HOST;
  port: number;
  storeRoot: string;
  maxConcurrent: number;
  repoRoot: string;
  /** Which documents and workspaces the boot seed writes; absent means "demo". */
  seedProfile?: SeedProfile;
  /** Static build dirs; default <repoRoot>/apps/viewer/dist and <repoRoot>/apps/studio/dist. */
  staticDirs?: { viewer?: string; studio?: string };
}

/** Repo root resolved from this file's location (apps/server/src). */
export function repoRoot(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const root = repoRoot();
  const port = env.ALM_PLATFORM_PORT !== undefined ? Number(env.ALM_PLATFORM_PORT) : 8787;
  const maxConcurrent =
    env.ALM_PLATFORM_MAX_CONCURRENT !== undefined ? Number(env.ALM_PLATFORM_MAX_CONCURRENT) : 1;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`ALM_PLATFORM_PORT must be an integer port, got "${env.ALM_PLATFORM_PORT}"`);
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(
      `ALM_PLATFORM_MAX_CONCURRENT must be a positive integer, got "${env.ALM_PLATFORM_MAX_CONCURRENT}"`,
    );
  }
  const seedProfile = env.ALM_SEED_PROFILE ?? "demo";
  const known = seedProfileIds();
  if (!known.includes(seedProfile)) {
    throw new Error(`ALM_SEED_PROFILE must be one of ${known.map((p) => `"${p}"`).join(", ")}, got "${seedProfile}"`);
  }
  return {
    host: BIND_HOST,
    port,
    storeRoot: env.ALM_PLATFORM_STORE ?? join(root, "var", "store"),
    maxConcurrent,
    repoRoot: root,
    seedProfile,
  };
}

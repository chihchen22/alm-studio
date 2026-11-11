/**
 * The one command a newcomer runs: npm run studio
 *
 * Builds the Studio when it has no build yet, then starts the platform on the starter store: the demo catalogue's
 * documents and no workspace, so the Studio opens on its three start choices. The defaults are a store of its own
 * (var/store-starter) and the starter profile; ALM_PLATFORM_STORE, ALM_SEED_PROFILE and ALM_PLATFORM_PORT still
 * override them. Nothing here deletes anything.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../src/config";

const root = repoRoot();
process.env.ALM_SEED_PROFILE ??= "starter";
process.env.ALM_PLATFORM_STORE ??= join(root, "var", "store-starter");

if (!existsSync(join(root, "apps", "studio", "dist", "index.html"))) {
  console.log("studio: building the Studio once (apps/studio/dist)");
  const r = spawnSync("npm", ["run", "build", "--workspace", "@alm/studio"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log(`studio: store ${process.env.ALM_PLATFORM_STORE}, profile ${process.env.ALM_SEED_PROFILE}`);
await import("../src/main");

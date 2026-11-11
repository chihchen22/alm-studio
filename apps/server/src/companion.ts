/**
 * The one import point of the optional extension folder in the server. The folder sits beside the
 * workspaces; when it is present its server entry registers its seed profiles and readiness rules (src/registry.ts).
 * When it is absent this is a no-op that returns false: nothing is imported and nothing fails.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./config";

let loaded: Promise<boolean> | null = null;

/** Load the pack's server entry once. Resolves true when the pack was present and registered itself. */
export function loadCompanion(root: string = repoRoot()): Promise<boolean> {
  if (loaded === null) {
    const entry = join(root, "companion", "server", "register.ts");
    loaded = existsSync(entry) ? import(pathToFileURL(entry).href).then(() => true) : Promise.resolve(false);
  }
  return loaded;
}

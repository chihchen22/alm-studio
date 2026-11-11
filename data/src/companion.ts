/**
 * The one import point of the optional extension folder in the data workspace: the acceptance battery calls it before
 * reading its checks. When the pack is present its accept entry registers its own checks, with
 * their register entries (examples/accept/registry.ts); when it is absent this returns false and imports nothing.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let loaded: Promise<boolean> | null = null;

export function loadAcceptCompanion(root: string = REPO_ROOT): Promise<boolean> {
  if (loaded === null) {
    const entry = join(root, "companion", "data", "register.ts");
    loaded = existsSync(entry) ? import(pathToFileURL(entry).href).then(() => true) : Promise.resolve(false);
  }
  return loaded;
}

import { configDefaults, defineConfig } from "vitest/config";

/** Root run: vitest defaults, minus the Studio design gate suite (node:test, run with `node --test`). */
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "apps/studio/design/**"] },
});

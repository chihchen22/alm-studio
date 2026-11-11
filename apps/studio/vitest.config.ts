import { defineConfig } from "vitest/config";

/** Workspace run (`npm test --workspace @alm/studio`): the app tests only; design/ is a node:test suite. */
export default defineConfig({
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});

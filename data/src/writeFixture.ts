/**
 * Emit the committed portfolio fixture to data/fixtures/portfolio.fixture.json.
 *
 * Run with: npx tsx src/writeFixture.ts (from the data/ workspace). Regenerating
 * with the same master seed reproduces the same file byte-for-byte; the test
 * suite reads it back and asserts the content hash still matches a fresh book.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildFixture } from "./fixture";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../fixtures");
const outPath = resolve(outDir, "portfolio.fixture.json");

const fixture = buildFixture();
mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

// eslint-disable-next-line no-console
console.log(`wrote ${outPath}\n  positions=${fixture.positionCount} hash=${fixture.contentHash}`);

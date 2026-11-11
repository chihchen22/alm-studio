/**
 * Platform entry point:  npm run platform  (root script, tsx).
 *
 * Boots the store (seeding it on first boot so there is something to run),
 * scans for orphaned runs, and serves the API plus the built workbench on
 * 127.0.0.1 (localhost only, no deploy).
 */
import { loadCompanion } from "./companion";
import { resolveConfig } from "./config";
import { startPlatformServer } from "./server";
import { FileStore } from "./store/store";
import { formatRetiredBlock, formatStaleBlock, seedStore } from "../scripts/seed-store";
import { formatWorkspaceSeedReport } from "../scripts/seed-workspaces";

async function main(): Promise<void> {
  // The optional extension folder, when present, registers its seed profiles before the profile is resolved.
  const pack = await loadCompanion();
  const config = resolveConfig();
  if (pack) console.log("platform: extension folder loaded");

  // Seed on every boot; existing ids are skipped (append-only store).
  const store = new FileStore(config.storeRoot);
  // ALM_SEED_PROFILE picks the documents and workspaces (default demo).
  const seedReport = await seedStore(store, config.repoRoot, { mode: "seed" }, config.seedProfile ?? "demo");
  if (seedReport.written.length > 0) {
    console.log(`platform: seeded ${seedReport.written.length} store artifact(s):`);
    for (const w of seedReport.written) console.log(`platform:   ${w}`);
  }
  // A stale seeded document is reported, never rewritten, and never blocks boot.
  for (const s of seedReport.stale) for (const line of formatStaleBlock(s)) console.log(line);
  // A retired seed id still in the store is reported, never moved at boot.
  for (const r of seedReport.retired) for (const line of formatRetiredBlock(r)) console.log(line);
  // Studio A+E: the workspaces derived from the store, the seed map and the documents no workspace holds.
  if (seedReport.workspaces !== undefined) {
    for (const line of formatWorkspaceSeedReport(seedReport.workspaces, "platform:")) console.log(line);
  }

  const platform = await startPlatformServer(config, { seedReport });
  const { interrupted, requeued } = platform.bootScan;
  for (const id of interrupted) {
    console.log(`platform: boot scan marked run ${id} interrupted (lost supervisor)`);
  }
  for (const id of requeued) {
    console.log(`platform: boot scan re-enqueued run ${id}`);
  }

  console.log(`platform: store   ${config.storeRoot}`);
  console.log(`platform: serving http://${config.host}:${platform.port}/api/health`);
  console.log(`platform: studio  http://${config.host}:${platform.port}/studio/`);
  console.log(`platform: bind is 127.0.0.1 only; Ctrl+C to stop`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

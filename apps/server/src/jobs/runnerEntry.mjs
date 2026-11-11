// Plain-JS child bootstrap: a spawned Node process cannot load TypeScript
// directly, so this entry registers tsx and imports the TS runner body — the
// exact loader shape proven by the kernel's shard workerEntry.mjs on this
// Windows machine (risk R1). Spawned as:
//
//   spawn(process.execPath, [runnerEntry.mjs, <runDir>])
//
// A bootstrap failure prints a typed error line on stdout (the parent's
// protocol channel) and exits nonzero; it never dies silently.
try {
  const { tsImport } = await import("tsx/esm/api");
  await tsImport("./runnerEntry.ts", import.meta.url);
} catch (err) {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stdout.write(`${JSON.stringify({ t: "error", message: "runner bootstrap failed", detail: message })}\n`);
  process.exit(1);
}

// Plain-JS worker bootstrap: worker_threads cannot load TypeScript directly,
// so this entry registers tsx and imports the TS worker body. One loader that
// works under both vitest runs and `npm run demo` (tsx) on Windows.
// A load failure still posts {error} and flips the flag — the main thread is
// blocked on Atomics.wait and must never be left hanging.
import { workerData } from "node:worker_threads";

try {
  const { tsImport } = await import("tsx/esm/api");
  await tsImport("./shardWorker.ts", import.meta.url);
} catch (err) {
  const flag = new Int32Array(workerData.sab);
  workerData.port.postMessage({ error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  Atomics.store(flag, 0, 2);
  Atomics.notify(flag, 0);
}

/**
 * The learn kit's seed step: tsx apps/server/scripts/seed-learn.ts --base http://127.0.0.1:<port>
 *
 * Run by scripts/learn.mjs once the platform server on the learn store answers. It makes, through the Studio's own
 * calls against that server (apps/studio/src/guided/learnSeed.ts), the finished analysis on Quillfield Bank, the
 * deposit desk's workspace and one run of every demo, and waits for the runs. It only adds: a second start keeps what
 * the store holds. Exit code 0 when it finished (a slot left for the learner is said, not an error), 1 when a write
 * failed.
 */
import { seedLearnStore } from "../../studio/src/guided/learnSeed";

/** The server the seed talks to: `--base <url>`, loopback only. */
export function parseLearnSeedArgs(argv: readonly string[]): { base: string } {
  const i = argv.indexOf("--base");
  const base = i >= 0 ? argv[i + 1] : undefined;
  if (base === undefined || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(base)) {
    throw new Error("seed-learn: give --base http://127.0.0.1:<port>, the learn server's address");
  }
  return { base };
}

/** The Studio's reader calls relative /api paths; send them to the learn server. */
export function fetchOn(base: string, realFetch: typeof fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    realFetch(typeof input === "string" && input.startsWith("/") ? `${base}${input}` : input, init)) as typeof fetch;
}

const invokedDirectly = process.argv[1] !== undefined && /seed-learn\.(ts|mjs|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  const say = (line: string) => console.log(`learn: ${line}`);
  (async () => {
    const { base } = parseLearnSeedArgs(process.argv.slice(2));
    globalThis.fetch = fetchOn(base, globalThis.fetch.bind(globalThis));
    const t0 = Date.now();
    const report = await seedLearnStore(say);
    const secs = Math.round((Date.now() - t0) / 1000);
    if (report.made.length > 0) say(`made ${report.made.join(" and ")}`);
    say(`${report.launched.length} run${report.launched.length === 1 ? "" : "s"} launched, ${report.kept.length} already done (${secs} s)`);
    for (const l of report.left) say(`left for you: ${l}`);
    return 0;
  })().then(
    (code) => { process.exitCode = code; },
    (err: unknown) => {
      console.error(`learn: the seed stopped: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}

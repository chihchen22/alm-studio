#!/usr/bin/env node
/**
 * The learn kit: one command to open the Studio on Quillfield Bank with every result ready.
 *
 *   npm run learn          start the platform server on var/store-learn-quillfield with the learn profile, then make
 *                          the finished analysis, the deposit desk's workspace and one run of every demo on it
 *   npm run learn:reset    move var/store-learn-quillfield to var/superseded-learn-quillfield/<stamp> (never deletes)
 *
 *   npm run learn -- --port <n> --store <folder>   another first port (it tries 20 from there) and another store
 *
 * `npm run learn` checks Node is 22 or newer, builds the Studio bundle only when apps/studio/dist/index.html is absent,
 * takes port 8787 unless it is busy (then says so and takes the next free one), and starts apps/server/src/main.ts with
 * the settings that travel together: ALM_SEED_PROFILE=learn, ALM_PLATFORM_STORE=<store> and ALM_PLATFORM_PORT. The
 * server seeds the learn profile's documents at boot. Once /api/health answers for that store, the kit runs
 * apps/server/scripts/seed-learn.ts against it, which makes the rest through the Studio's own calls and waits for the
 * runs; a second start keeps what the store holds. Then it prints the Studio URL, how long the start took, how to stop
 * the server and the reset command. It refuses to start a second server on a store a learn server already serves. No
 * other store is read.
 *
 * Start and reset both refuse while a server is live on the store, whatever `--port` either command named: the kit
 * writes `learn.lock.json` in the store (its pid, its server's pid and port) and clears it on stop, the platform server
 * keeps its own marker, and a lock or marker whose pid is gone is stale. The port range is probed too. A server on
 * another store does not block either.
 *
 * Node built-ins only. The pure parts are exported for scripts/__tests__/learnKit.test.ts.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MIN_NODE_MAJOR = 22;
export const LEARN_PORT = 8787;
/** How many ports from the first port the start tries, and the reset probes. */
export const PORT_TRIES = 20;
/** The core seed profile of the learn store (apps/server/src/registry.ts LEARN_SEED_PROFILE). */
export const LEARN_PROFILE = "learn";
/** The seed step run against the live server. */
export const LEARN_SEED_SCRIPT = join("apps", "server", "scripts", "seed-learn.ts");
const HOST = "127.0.0.1";

/** Reads a `process.version` string; ok when the major version is MIN_NODE_MAJOR or newer. */
export function checkNodeVersion(version) {
  const m = /^v?(\d+)\./.exec(version);
  const major = m === null ? Number.NaN : Number(m[1]);
  const ok = Number.isInteger(major) && major >= MIN_NODE_MAJOR;
  const message = ok
    ? `Node ${version} is fine.`
    : `The Studio needs Node ${MIN_NODE_MAJOR} or newer. This terminal has Node ${version}. ` +
      `Install Node ${MIN_NODE_MAJOR} or newer from https://nodejs.org, open a new terminal and run npm run learn again.`;
  return { ok, major, message };
}

/** The learn store (or the one `--store` names), the folder reset moves it into, and the Studio bundle's index page. */
export function learnPaths(root, store) {
  const s = store === undefined ? join(root, "var", "store-learn-quillfield") : isAbsolute(store) ? store : join(root, store);
  return {
    store: s,
    supersededDir: store === undefined ? join(root, "var", "superseded-learn-quillfield") : join(dirname(s), `superseded-${s.split(/[\\/]/).pop()}`),
    studioIndex: join(root, "apps", "studio", "dist", "index.html"),
  };
}

/**
 * The command line: nothing or `reset` first, then `--port <n>` (the first port to try, 1024 to 65515) and `--store
 * <folder>`, each at most once. Returns { error } for anything else.
 */
export function parseLearnArgs(argv) {
  const out = { mode: "start", port: LEARN_PORT, store: undefined };
  let i = 0;
  if (argv[0] === "reset") {
    out.mode = "reset";
    i = 1;
  }
  const seen = new Set();
  for (; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== "--port" && flag !== "--store") || value === undefined || value.startsWith("--") || seen.has(flag)) {
      return { error: `unknown argument "${argv.slice(i).join(" ")}". Use npm run learn, npm run learn:reset, and optionally --port <n> --store <folder>.` };
    }
    seen.add(flag);
    if (flag === "--port") {
      const p = Number(value);
      if (!Number.isInteger(p) || p < 1024 || p > 65535 - PORT_TRIES) return { error: `--port needs a whole number from 1024 to ${65535 - PORT_TRIES}, got "${value}".` };
      out.port = p;
    } else {
      out.store = value;
    }
  }
  return out;
}

/** UTC stamp in the run-id style: YYYYMMDD-HHMMSS. */
export function resetStamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

/** First port from `start` that `isFree` accepts, trying `tries` ports; null when all are busy. */
export async function choosePort(start, isFree, tries = PORT_TRIES) {
  for (let p = start; p < start + tries; p++) {
    if (await isFree(p)) return p;
  }
  return null;
}

/** The server environment: the profile, the store and the port are set together, never one without the others. */
export function learnEnv(baseEnv, store, port) {
  return { ...baseEnv, ALM_SEED_PROFILE: LEARN_PROFILE, ALM_PLATFORM_STORE: store, ALM_PLATFORM_PORT: String(port) };
}

export function studioUrl(port) {
  return `http://${HOST}:${port}/studio/`;
}

/** Seconds, to one decimal. */
export function seconds(ms) {
  return (ms / 1000).toFixed(1);
}

/** First port whose platform server reports `store` (probe returns the reported store path or null). */
export async function findLearnServer(ports, probe, store) {
  for (const p of ports) {
    const reported = await probe(p);
    if (reported !== null && resolve(reported) === resolve(store)) return p;
  }
  return null;
}

/** The kit's lock in the store: the kit's pid, its server's pid and port, written at start and cleared on stop. */
export const LOCK_FILE = "learn.lock.json";
/** The platform server's own marker (apps/server/src/workspaces/workspaceStore.ts writeServerMarker). */
export const SERVER_MARKER = join("workspaces", ".server.json");

/** True when a process with this pid exists (EPERM: it exists, not ours to signal). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Who serves `store` now, whatever port either command was given: the kit's lock when its pid (or its server's) is
 * alive, else the platform server's own marker when its pid is alive. Null when neither is live; a lock or marker whose
 * pid is gone is stale and ignored. `alive` is the pid test, a test hands in its own.
 */
export function liveHolder(store, alive = pidAlive) {
  const lock = readJson(join(store, LOCK_FILE));
  if (lock !== null && (alive(lock.pid) || alive(lock.serverPid))) return { port: Number.isInteger(lock.port) ? lock.port : null, by: "lock" };
  const marker = readJson(join(store, SERVER_MARKER));
  if (marker !== null && alive(marker.pid)) return { port: null, by: "server" };
  return null;
}

/** The reset command for the store and first port in use: the default spelled plainly, anything else with its flags. */
export function resetCommand(opts) {
  const flags = [...(opts.port !== LEARN_PORT ? ["--port", String(opts.port)] : []), ...(opts.store !== undefined ? ["--store", opts.store] : [])];
  return flags.length === 0 ? "npm run learn:reset" : `npm run learn:reset -- ${flags.join(" ")}`;
}

/** True when nothing listens on 127.0.0.1:port (the platform's only bind). */
function portIsFree(port) {
  return new Promise((done) => {
    const s = createServer();
    s.once("error", () => done(false));
    s.once("listening", () => s.close(() => done(true)));
    s.listen(port, HOST);
  });
}

/** The store path a platform server on `port` reports in /api/health, or null when none answers. */
async function probeStorePath(port) {
  try {
    const res = await fetch(`http://${HOST}:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.storePath === "string" ? body.storePath : null;
  } catch {
    return null;
  }
}

const say = (line) => console.log(`learn: ${line}`);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const range = (first) => Array.from({ length: PORT_TRIES }, (_, i) => first + i);

async function start(opts) {
  const t0 = Date.now();
  const paths = learnPaths(REPO_ROOT, opts.store);
  const tsxCli = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsxCli)) {
    say("the packages are not installed yet. Run npm install in this folder, then npm run learn again.");
    return 1;
  }

  // A server live on the store refuses the start, whatever --port either command named, and on a new folder too.
  const fresh = !existsSync(paths.store);
  const holder = liveHolder(paths.store);
  const probed = await findLearnServer(range(opts.port), probeStorePath, paths.store);
  const running = probed ?? holder?.port ?? null;
  if (holder !== null || probed !== null) {
    say(running !== null
      ? `the learn server is already running on port ${running}. Open ${studioUrl(running)}, or stop it first (Ctrl+C in its terminal).`
      : "a platform server is already running on this store. Stop it first (Ctrl+C in its terminal).");
    return 1;
  }
  if (fresh) mkdirSync(paths.store, { recursive: true });

  if (!existsSync(paths.studioIndex)) {
    say("the Studio bundle is not built yet; building it once.");
    const built = spawnSync(npmCommand, ["run", "build", "--workspace", "@alm/studio"], { cwd: REPO_ROOT, stdio: "inherit", shell: process.platform === "win32" });
    if (built.status !== 0 || !existsSync(paths.studioIndex)) {
      say("the Studio build failed; read the output above.");
      return 1;
    }
  }

  const port = await choosePort(opts.port, portIsFree);
  if (port === null) {
    say(`ports ${opts.port} to ${opts.port + PORT_TRIES - 1} are all busy. Stop another server and try again.`);
    return 1;
  }
  if (port !== opts.port) say(`port ${opts.port} is busy (another server is using it); using port ${port} instead.`);

  say(`store ${paths.store}${fresh ? " (new; it is seeded on this first start)" : ""}`);
  say("starting the platform server...");
  const env = learnEnv(process.env, paths.store, port);
  const child = spawn(process.execPath, [tsxCli, join("apps", "server", "src", "main.ts")], { cwd: REPO_ROOT, env, stdio: "inherit" });
  const lockPath = join(paths.store, LOCK_FILE);
  writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, serverPid: child.pid ?? null, port, startedAt: new Date().toISOString() }, null, 2)}\n`);
  const clearLock = () => {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone, or the store was moved: nothing to clear.
    }
  };
  process.on("exit", clearLock);
  // Ctrl+C reaches the server through the terminal; a signal sent to this script alone is passed on.
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));

  let exited = false;
  const exitCode = new Promise((done) =>
    child.on("exit", (code, signal) => {
      exited = true;
      done(signal !== null ? 0 : (code ?? 1));
    }),
  );

  // Seed and announce only once the server on that port answers for the learn store.
  while (!exited) {
    if ((await findLearnServer([port], probeStorePath, paths.store)) === port) {
      const tServer = Date.now();
      say(`the server answers (${seconds(tServer - t0)} s); setting up the analysis and the demos...`);
      const seed = spawnSync(process.execPath, [tsxCli, LEARN_SEED_SCRIPT, "--base", `http://${HOST}:${port}`], { cwd: REPO_ROOT, env, stdio: "inherit" });
      const tSeed = Date.now();
      say("");
      if (seed.status === 0) {
        say(`the Studio is ready, in ${seconds(tSeed - t0)} s (server ${seconds(tServer - t0)} s, analysis and demos ${seconds(tSeed - tServer)} s).`);
      } else if ((await findLearnServer([port], probeStorePath, paths.store)) === port) {
        say("the setup did not finish; read the lines above. The Studio still opens, and Start here says what each step needs.");
      } else {
        say("the setup did not finish and the server no longer answers; read the lines above, then run the same command again.");
        break;
      }
      say(`  open   ${studioUrl(port)}`);
      say("  stop   press Ctrl+C in this terminal");
      say(`  reset  ${resetCommand(opts)}   (moves the learn store aside; nothing is deleted)`);
      say("");
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const code = await exitCode;
  clearLock();
  say("the server has stopped.");
  return code;
}

async function reset(opts) {
  const paths = learnPaths(REPO_ROOT, opts.store);
  if (!existsSync(paths.store)) {
    say(`nothing to reset: ${paths.store} does not exist. npm run learn makes a fresh one.`);
    return 0;
  }
  // A server live on the store refuses the reset, whatever --port either command named.
  const holder = liveHolder(paths.store);
  const probed = await findLearnServer(range(opts.port), probeStorePath, paths.store);
  if (holder !== null || probed !== null) {
    const port = probed ?? holder?.port ?? null;
    say(`the learn server is running${port !== null ? ` on port ${port}` : " on this store"}. Stop it first (Ctrl+C in its terminal), then run ${resetCommand(opts)} again.`);
    return 1;
  }
  const target = join(paths.supersededDir, resetStamp(new Date()));
  if (existsSync(target)) {
    say(`${target} already exists; wait a second and run npm run learn:reset again.`);
    return 1;
  }
  mkdirSync(paths.supersededDir, { recursive: true });
  renameSync(paths.store, target);
  say(`moved the learn store to ${target}`);
  say("nothing was deleted. The next npm run learn starts on a fresh store.");
  return 0;
}

async function main(argv) {
  const node = checkNodeVersion(process.version);
  if (!node.ok) {
    say(node.message);
    return 1;
  }
  const opts = parseLearnArgs(argv);
  if ("error" in opts) {
    say(opts.error);
    return 1;
  }
  return opts.mode === "reset" ? reset(opts) : start(opts);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

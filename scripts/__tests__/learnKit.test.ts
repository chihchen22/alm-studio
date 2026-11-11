/**
 * The learn kit (`npm run learn`, `npm run learn:reset`): the pure parts only. Port choice
 * and the learn-server probe take their I/O as arguments, so nothing here opens a socket or a store. Expected values
 * are restated by hand.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEARN_PORT,
  LEARN_PROFILE,
  LEARN_SEED_SCRIPT,
  PORT_TRIES,
  REPO_ROOT,
  checkNodeVersion,
  choosePort,
  findLearnServer,
  learnEnv,
  learnPaths,
  liveHolder,
  parseLearnArgs,
  resetCommand,
  resetStamp,
  seconds,
  studioUrl,
  // @ts-expect-error: a plain .mjs script with no type declarations
} from "../learn.mjs";

describe("checkNodeVersion", () => {
  it("accepts Node 22 and newer and refuses older, naming both versions", () => {
    expect(checkNodeVersion("v22.0.0")).toMatchObject({ ok: true, major: 22 });
    expect(checkNodeVersion("v24.1.0")).toMatchObject({ ok: true, major: 24 });
    const r = checkNodeVersion("v20.11.1");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Node 22 or newer");
    expect(r.message).toContain("v20.11.1");
    expect(checkNodeVersion("garbage").ok).toBe(false);
  });
});

describe("learnPaths", () => {
  it("puts the learn store and its superseded folder under var/, in folders of their own", () => {
    const p = learnPaths("/repo");
    expect(p.store).toBe(join("/repo", "var", "store-learn-quillfield"));
    expect(p.supersededDir).toBe(join("/repo", "var", "superseded-learn-quillfield"));
    expect(p.studioIndex).toBe(join("/repo", "apps", "studio", "dist", "index.html"));
  });

  it("takes another store, absolute or under the repo root, and moves it aside beside itself", () => {
    expect(learnPaths("/repo", "/tmp/s1").store).toBe("/tmp/s1");
    expect(learnPaths("/repo", "/tmp/s1").supersededDir).toBe(join("/tmp", "superseded-s1"));
    expect(learnPaths("/repo", "var/x").store).toBe(join("/repo", "var", "x"));
  });
});

describe("parseLearnArgs", () => {
  it("reads start and reset, with an optional first port and store", () => {
    expect(parseLearnArgs([])).toEqual({ mode: "start", port: 8787, store: undefined });
    expect(parseLearnArgs(["reset"])).toEqual({ mode: "reset", port: 8787, store: undefined });
    expect(parseLearnArgs(["--port", "8870", "--store", "/tmp/s"])).toEqual({ mode: "start", port: 8870, store: "/tmp/s" });
    expect(parseLearnArgs(["reset", "--store", "/tmp/s"])).toEqual({ mode: "reset", port: 8787, store: "/tmp/s" });
  });

  it("refuses an unknown argument, a repeated flag, a flag with no value and a port out of range", () => {
    for (const argv of [["start"], ["--port"], ["--port", "8870", "--port", "8871"], ["--port", "80"], ["--port", "65530"], ["--port", "abc"], ["--store", "--port"]]) {
      expect(parseLearnArgs(argv), argv.join(" ")).toHaveProperty("error");
    }
  });
});

describe("resetStamp", () => {
  it("stamps in UTC as YYYYMMDD-HHMMSS", () => {
    expect(resetStamp(new Date(Date.UTC(2026, 10, 5, 13, 6, 53)))).toBe("20261105-130653");
  });
});

describe("choosePort", () => {
  it("defaults to 8787 and tries twenty ports", () => {
    expect(LEARN_PORT).toBe(8787);
    expect(PORT_TRIES).toBe(20);
  });

  it("returns the first free port from the start, or null when all are busy", async () => {
    expect(await choosePort(8870, async () => true)).toBe(8870);
    const busy = new Set([8870, 8871]);
    expect(await choosePort(8870, async (p: number) => !busy.has(p))).toBe(8872);
    expect(await choosePort(8870, async () => false, 3)).toBeNull();
  });
});

describe("learnEnv", () => {
  it("sets the learn profile, the store and the port together and keeps the rest", () => {
    expect(learnEnv({ PATH: "/bin", ALM_SEED_PROFILE: "demo" }, "/repo/var/store-learn-quillfield", 8790)).toEqual({
      PATH: "/bin",
      ALM_SEED_PROFILE: "learn",
      ALM_PLATFORM_STORE: "/repo/var/store-learn-quillfield",
      ALM_PLATFORM_PORT: "8790",
    });
    expect(LEARN_PROFILE).toBe("learn");
  });
});

describe("the seed step", () => {
  it("is the core seed-learn script, present in the repo, which names no companion path", () => {
    expect(LEARN_SEED_SCRIPT).toBe(join("apps", "server", "scripts", "seed-learn.ts"));
    expect(existsSync(join(REPO_ROOT, LEARN_SEED_SCRIPT))).toBe(true);
    for (const f of ["scripts/learn.mjs", LEARN_SEED_SCRIPT, "apps/studio/src/guided/learnSeed.ts"]) {
      expect(readFileSync(join(REPO_ROOT, f), "utf8"), f).not.toMatch(/companion\//);
    }
  });
});

describe("the npm scripts", () => {
  it("run the core kit as learn and learn:reset; any other script that runs a learn kit goes through the pack runner", () => {
    const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
    expect(scripts.learn).toBe("node scripts/learn.mjs");
    expect(scripts["learn:reset"]).toBe("node scripts/learn.mjs reset");
    for (const [name, command] of Object.entries(scripts)) {
      if (name !== "learn" && name !== "learn:reset" && command.includes("learn.mjs")) expect(command, name).toMatch(/^node scripts\/companion-run\.mjs /);
    }
  });
});

describe("small parts", () => {
  it("points the Studio at /studio/ on the loopback bind and prints seconds to one decimal", () => {
    expect(studioUrl(8870)).toBe("http://127.0.0.1:8870/studio/");
    expect(seconds(12_345)).toBe("12.3");
  });

  it("finds the port whose health reports the learn store, and ignores another store", async () => {
    const store = "/repo/var/store-learn-quillfield";
    const probe = async (p: number) => (p === 8871 ? store : p === 8870 ? "/repo/var/store-other" : null);
    expect(await findLearnServer([8870, 8871, 8872], probe, store)).toBe(8871);
    expect(await findLearnServer([8870, 8872], probe, store)).toBeNull();
  });
});

describe("who serves the store (fix round M1)", () => {
  const store = () => {
    const d = mkdtempSync(join(tmpdir(), "learn-lock-"));
    mkdirSync(join(d, "workspaces"));
    return d;
  };
  const lock = (d: string, body: object) => writeFileSync(join(d, "learn.lock.json"), JSON.stringify(body));
  const marker = (d: string, pid: number) => writeFileSync(join(d, "workspaces", ".server.json"), JSON.stringify({ pid, startedAt: "x" }));
  const aliveOnly = (pids: number[]) => (pid: number) => pids.includes(pid);

  it("reads a live kit lock with its port, whatever port the next command names (start or reset on another --port)", () => {
    const d = store();
    lock(d, { pid: 111, serverPid: 222, port: 8870 });
    // The holder carries no notion of the asking command's port: a start on --port 8875 and a reset on --port 8880 both see it.
    expect(liveHolder(d, aliveOnly([111]))).toEqual({ port: 8870, by: "lock" });
    expect(liveHolder(d, aliveOnly([222]))).toEqual({ port: 8870, by: "lock" });
  });

  it("falls back on the platform server's own marker, and ignores a lock or marker whose pid is gone", () => {
    const d = store();
    lock(d, { pid: 111, serverPid: 222, port: 8870 });
    marker(d, 333);
    expect(liveHolder(d, aliveOnly([333]))).toEqual({ port: null, by: "server" });
    expect(liveHolder(d, aliveOnly([]))).toBeNull();
    expect(liveHolder(join(d, "no-such-folder"), aliveOnly([111]))).toBeNull();
  });

  it("names this process alive by default", () => {
    const d = store();
    lock(d, { pid: process.pid, serverPid: null, port: 8871 });
    expect(liveHolder(d)).toEqual({ port: 8871, by: "lock" });
  });
});

describe("the printed reset command (fix round L2)", () => {
  it("is plain on the defaults and carries --port and --store when either was given", () => {
    expect(resetCommand({ port: 8787, store: undefined })).toBe("npm run learn:reset");
    expect(resetCommand({ port: 8870, store: "/tmp/s" })).toBe("npm run learn:reset -- --port 8870 --store /tmp/s");
    expect(resetCommand({ port: 8787, store: "var/x" })).toBe("npm run learn:reset -- --store var/x");
  });
});

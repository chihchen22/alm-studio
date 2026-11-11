import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlatformServer, type PlatformServer } from "../server";
import { scratchConfig } from "./harness";

let p: PlatformServer; let base: string;
beforeAll(async () => {
  const studio = mkdtempSync(join(tmpdir(), "studio-dist-"));
  mkdirSync(join(studio, "assets"));
  writeFileSync(join(studio, "index.html"), "<!doctype html><title>Studio</title>");
  writeFileSync(join(studio, "assets", "a.js"), "console.log(1)");
  // Pin the viewer dist to a path that does not exist, so the 404 premise holds
  // even where a local (gitignored) apps/viewer/dist build is present.
  const cfg = scratchConfig(); cfg.staticDirs = { studio, viewer: join(studio, "no-viewer-dist") };
  p = await startPlatformServer(cfg); base = `http://127.0.0.1:${p.port}`;
});
afterAll(() => p.close());

describe("/studio/ static", () => {
  it("serves index.html at /studio and /studio/", async () => {
    for (const path of ["/studio", "/studio/"]) {
      const r = await fetch(base + path); expect(r.status).toBe(200);
      expect(await r.text()).toContain("<title>Studio</title>");
    }
  });
  it("serves an asset with its type and strips the prefix", async () => {
    const r = await fetch(base + "/studio/assets/a.js");
    expect(r.status).toBe(200); expect(r.headers.get("content-type")).toContain("text/javascript");
  });
  it("falls back to index.html for a deep link without an extension", async () => {
    const r = await fetch(base + "/studio/market"); expect(r.status).toBe(200);
    expect(await r.text()).toContain("<title>Studio</title>");
  });
  it("redirects the root and /index.html to /studio/, even when the viewer dist is absent", async () => {
    for (const path of ["/", "/index.html"]) {
      const r = await fetch(base + path, { redirect: "manual" });
      expect(r.status).toBe(302); expect(r.headers.get("location")).toBe("/studio/");
    }
  });
  it("keeps a redirected root from serving the Workbench shell", async () => {
    const r = await fetch(base + "/", { redirect: "follow" });
    expect(r.status).toBe(200); expect(await r.text()).toContain("<title>Studio</title>");
  });
});

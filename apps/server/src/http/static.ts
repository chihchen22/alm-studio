/**
 * Static file serving for the built workbench ("server-served
 * static in prod"). Serves apps/viewer/dist when it exists; in dev the Vite
 * dev server proxies /api here instead and this module never fires. No
 * directory listings, no path traversal, no write surface.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/**
 * Try to serve `pathname` from `distDir`. Returns false when the request is
 * not servable (caller then 404s). "/" maps to index.html; unknown extension
 * falls back to index.html for hash-router deep links.
 */
export function serveStatic(res: ServerResponse, distDir: string, pathname: string): boolean {
  if (!existsSync(distDir)) return false;
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = normalize(join(distDir, rel));
  if (!resolved.startsWith(normalize(distDir) + sep) && resolved !== normalize(join(distDir, "index.html"))) {
    return false; // traversal attempt; refuse
  }
  let filePath = resolved;
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // Hash-router shell fallback: serve index.html for non-asset paths.
    if (extname(rel) === "" || extname(rel) === ".html") {
      filePath = join(distDir, "index.html");
      if (!existsSync(filePath)) return false;
    } else {
      return false;
    }
  }
  res.writeHead(200, {
    "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
  });
  createReadStream(filePath).pipe(res);
  return true;
}

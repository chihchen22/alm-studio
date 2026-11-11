/**
 * The feature demos' read. Read-only: nothing here writes the store.
 *
 *   GET /api/guided/examples/:id/demos   { demos: [{ id, title, lineageId, setupId, setIds, stored }] } for an example
 *                                        book that ships demos: Quillfield Bank (the seven, then the funding
 *                                        tenor, then the survival path) and Quillfield's deposit desk (the six);
 *                                        an empty list for any other
 *                                        example, 404 for a book that is not an example
 *
 * The seed writes each demo's setup and sets (src/examples/featureDemos.ts); `stored` says whether this store holds
 * them, so a store seeded before the slice shows the cards without an Open button rather than failing on a missing id.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PlatformContext } from "../../context";
import { DEMO_BOOK_ID, featureDemos, type FeatureDemoRow } from "../../examples/featureDemos";
import { depositFormDemos } from "../../examples/depositForms";
import { survivalPathDemos } from "../../examples/survivalPathDemo";
import { notFound } from "../errors";
import type { Router } from "../router";

export function registerFeatureDemoRoutes(router: Router, ctx: PlatformContext): void {
  router.add("GET", "/api/guided/examples/:id/demos", (req) => {
    const id = req.params.id ?? "";
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || !existsSync(join(ctx.config.repoRoot, "examples", `${id}.json`))) {
      throw notFound(`no example book "${id}"; GET /api/guided/examples lists them`);
    }
    // The demos of every module, by the book each runs on, the feature demos first.
    const all = [
      ...(id === DEMO_BOOK_ID ? featureDemos(ctx.config.repoRoot) : []),
      ...depositFormDemos(ctx.config.repoRoot).filter((d) => d.bookId === id),
      // The survival path, after the others.
      ...survivalPathDemos(ctx.config.repoRoot).filter((d) => d.bookId === id),
    ];
    const demos: FeatureDemoRow[] = all.map((d) => ({
      id: d.id,
      title: d.title,
      lineageId: d.lineageId,
      setupId: d.setup.id,
      setIds: [...d.setIds],
      stored: ctx.store.has("run-setups", d.setup.id) && d.setIds.every((s) => ctx.store.has("assumption-sets", s)),
    }));
    return { kind: "json", value: { demos } };
  });
}

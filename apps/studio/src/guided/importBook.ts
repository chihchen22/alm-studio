// apps/studio/src/guided/importBook.ts
/**
 * Loading positions without a raw refusal (S2a fix round 1, H1). The store is append-only: an id that is already
 * stored cannot be imported again. So the example book, whose id is fixed, is reused as stored when its id is already in the
 * store (a stored document never changes), and any other file whose id is taken is stored
 * under the first free id (`<id>-2`, `<id>-3`, ...), and the note says so. Pure helpers first, then the two calls.
 */
import { getExampleBook, importPortfolioJson, listPortfolios, type ExampleBookRow } from "@alm/reader";

/** The platform's id limit (apps/server/src/store/paths.ts ID_PATTERN): 1 to 64 of A-Z a-z 0-9 . _ - */
const MAX_ID = 64;

/** The id itself when free, else the first free `<id>-<n>` from 2 up, trimmed to the platform's 64 characters. */
export function freeBookId(id: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(id)) return id;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${id.slice(0, MAX_ID - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** A JSON positions file with its top-level `id` replaced; the rest of the file as parsed. Throws a sentence on bad JSON. */
export function jsonWithId(text: string, id: string): string {
  let spec: unknown;
  try {
    spec = JSON.parse(text);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) throw new Error("The JSON file is not a positions file: it has no top-level object.");
  return JSON.stringify({ ...(spec as Record<string, unknown>), id });
}

/** The top-level `id` of a JSON positions file, or null when it has none. */
export function jsonIdOf(text: string): string | null {
  try {
    const spec = JSON.parse(text) as { id?: unknown };
    return typeof spec.id === "string" ? spec.id : null;
  } catch {
    return null;
  }
}

/** The sentence that names an id clash and what was done about it; null when there was none. */
export function renamedNote(asked: string, stored: string): string | null {
  return asked === stored ? null : `A positions file with the id ${asked} is already stored, so this one is stored as ${stored}.`;
}

/** What loading the example does: reuse the stored example when its id is already in the store, else import it. */
export function exampleAction(exampleId: string, taken: readonly string[]): "reuse" | "import" {
  return taken.includes(exampleId) ? "reuse" : "import";
}

/** The example book's stored id, importing it first when the store does not hold it yet. Never a 409. */
export async function ensureExample(example: ExampleBookRow): Promise<{ id: string; reused: boolean }> {
  const taken = (await listPortfolios()).map((p) => p.id);
  if (exampleAction(example.id, taken) === "reuse") return { id: example.id, reused: true };
  try {
    const reply = await importPortfolioJson(JSON.stringify(await getExampleBook(example.id)));
    return { id: reply.id, reused: false };
  } catch (e) {
    // Another tab stored it between the list and the import: the stored example is the same file.
    const again = (await listPortfolios()).map((p) => p.id);
    if (again.includes(example.id)) return { id: example.id, reused: true };
    throw e;
  }
}

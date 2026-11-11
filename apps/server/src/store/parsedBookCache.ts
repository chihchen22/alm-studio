/**
 * A small in-memory cache of parsed position books (Studio A+E spec v3.1 Section 2.9).
 *
 * The positions read pages a stored book on every keystroke of the drop-down's
 * type-ahead, and a book of a few thousand positions is megabytes of JSON. The
 * parse is therefore kept per CONTENT HASH: the key is the meta record's
 * `contentHash`, so a book re-stored under the same id reads as a new entry the
 * moment its meta moves, and two requests for an unchanged book share one parse.
 * There is no invalidation hook and none is needed.
 *
 * The cache holds at most eight books and evicts the least recently used. The
 * parsed book is shared between requests and must be treated as read-only.
 */
import type { PortfolioSpec } from "@alm/engine";
import type { FileStore } from "./store";

const MAX_ENTRIES = 8;

interface Entry {
  book: PortfolioSpec;
  contentHash: string;
}

/** Map iteration order is insertion order: the first key is the least recently used. */
const entries = new Map<string, Entry>();

/**
 * The stored book `id` and the content hash it was parsed under. Reads the meta
 * record first (cheap, and the live source of the hash), and the document only
 * on a miss. Throws the store's NotFoundError for an unknown book.
 */
export function getParsedBook(
  store: Pick<FileStore, "getMeta" | "getDocument">,
  id: string,
): { book: PortfolioSpec; contentHash: string } {
  const hash = store.getMeta("portfolios", id).contentHash;
  const hit = entries.get(hash);
  if (hit !== undefined) {
    // Re-insert so the entry becomes the most recently used.
    entries.delete(hash);
    entries.set(hash, hit);
    return hit;
  }
  const stored = store.getDocument<PortfolioSpec>("portfolios", id);
  // The hash the document was read under is the meta read beside it, so a book
  // re-stored between the two reads is cached under the hash its bytes carry.
  const entry: Entry = { book: stored.doc, contentHash: stored.meta.contentHash };
  entries.set(entry.contentHash, entry);
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value as string;
    entries.delete(oldest);
  }
  return entry;
}

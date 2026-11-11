/** The store id of an index history (decision 48): `ih-` plus 16 hex of its canonical content hash, the `dc-` and `cs-` pattern. Node only (contentHash). */
import type { IndexHistory } from "../contracts/indexHistory";
import { contentHash } from "../runtime/contentHash";

export function indexHistoryIdOf(h: IndexHistory): string {
  return `ih-${contentHash(h).slice(0, 16)}`;
}

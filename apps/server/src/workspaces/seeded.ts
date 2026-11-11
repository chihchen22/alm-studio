/**
 * The seeded-document preference, shared by the seed's workspace generator and the create route.
 * A document is seeded when its store meta says `seeded: true`; where a collection holds several
 * candidates the seeded one is chosen, else the first listed (listMeta lists by id).
 */
import type { DocumentMeta } from "../store/store";

export function isSeeded(m: DocumentMeta): boolean {
  return m.seeded === true;
}

export function preferSeeded(ms: DocumentMeta[]): DocumentMeta | undefined {
  return ms.find(isSeeded) ?? ms[0];
}

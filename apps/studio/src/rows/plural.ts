// apps/studio/src/rows/plural.ts
/**
 * The one count-and-noun helper (Studio Part 2 m8). A count of exactly one takes the singular noun; zero and every
 * other count take the plural. Two exports: plural prints the bare count, pluralNoun returns the noun alone for a
 * caller that formats its own figure (the head band's meta line groups thousands).
 */

/** The noun for a count: the singular for exactly one, the plural otherwise. */
export function pluralNoun(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** "1 set", "0 sets", "2 sets". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${pluralNoun(n, one, many)}`;
}

/**
 * The head band's meta line (spec v3.1 Section 3.4): the facts of the workspace head the open section reads, from the
 * manifest itself and the store meta of the book. Nothing is read from a catalog path and nothing is computed here:
 * a count is printed as the head or the store meta holds it. The cut-off date closes every line except Govern's,
 * which prints the head's identity and whether it is signed and locked.
 */
import { Fragment, type ReactNode } from "react";
import { formatValue, type WorkspaceManifest } from "@alm/reader";
import type { SectionId } from "../router";
import { pluralNoun } from "../rows/plural";
import { TYPE_LABEL } from "./WorkspaceSwitcher";

/** The store meta the head does not hold. A null is a count that could not be read: it prints as Unobservable. */
export interface BookMeta {
  positionCount: number | null;
  doneRunCount?: number | null;
}

/** A figure with its noun in one text node, so the server render holds no comment marker between them. */
const figure = (n: number, one: string, many: string) => <span className="num">{`${formatValue("count", n)} ${pluralNoun(n, one, many)}`}</span>;

function lockText(head: WorkspaceManifest): string {
  return head.lock === null ? "not locked" : `signed and locked ${head.lock.lockedAt.slice(0, 10)} by ${head.lock.by}`;
}

function facts(section: SectionId, head: WorkspaceManifest, meta: BookMeta): ReactNode[] {
  const { market, positions, assumptions, run } = head.blocks;
  const done = meta.doneRunCount === undefined || meta.doneRunCount === null ? null : meta.doneRunCount;
  switch (section) {
    case "workspace":
      return [`${TYPE_LABEL[head.type]} workspace`, head.status, `revision ${head.revision}`, lockText(head)];
    case "market":
      return market.snapshot === null
        ? ["no base snapshot"]
        : [<span key="s">Snapshot <span className="mono">{market.snapshot.id}</span></span>, <span key="d">{figure(market.derived.length, "derived", "derived")}</span>];
    case "balance":
      if (positions.book === null) return ["no positions attached"];
      return [
        <span key="b">Book <span className="mono">{positions.book.id}</span></span>,
        meta.positionCount === null ? "positions Unobservable" : <span key="n">{figure(meta.positionCount, "position", "positions")}</span>,
      ];
    case "assumptions":
      return [
        <span key="n">{figure(assumptions.sets.length, "set", "sets")}</span>,
        assumptions.defaultSetId === null ? "no default set" : <span key="d">{`default ${assumptions.defaultSetId}`}</span>,
      ];
    case "run":
      return [<span key="s">{figure(run.setups.length, "setup", "setups")}</span>, done === null ? "done runs Unobservable" : <span key="r">{figure(done, "done run", "done runs")}</span>];
    case "results":
      return [done === null ? "done runs Unobservable" : <span key="r">{figure(done, "done run", "done runs")}</span>];
    case "govern":
      return [`${TYPE_LABEL[head.type]} workspace`, `revision ${head.revision}`, lockText(head)];
  }
}

export function manifestMeta(section: SectionId, head: WorkspaceManifest, meta: BookMeta): ReactNode {
  const parts = facts(section, head, meta);
  if (section !== "govern") parts.push(<span key="c" className="num">{`cut-off ${head.cutoffDate}`}</span>);
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{i > 0 ? " · " : null}{p}</Fragment>
      ))}
    </>
  );
}

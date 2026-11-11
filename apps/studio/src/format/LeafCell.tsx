// apps/studio/src/format/LeafCell.tsx
/**
 * A stored leaf's cell: the Stack diff's From and To (Polish 4 T4) and each By kind set column (Polish 5 T1). A
 * figure is right-aligned in the theme's figure face with tabular figures (num) and its exact stored text as the
 * title; a string, boolean or stored null leaf stays mono. A cell with no stored leaf (By kind's Not bound and Not
 * stored, and Not stored on a Stack diff side whose binding stores no leaf at the path) is an absence word: body
 * face, muted ink, right edge (Polish 5 T1, Task 6 fix I1, Polish 6 T1). All are 12 px on one line, as are the other
 * cells of the row (one rule for all; words sets only the 12 px one-line size, so a figure takes its face from num).
 * The value headers are num, so they end on their figures' right edge (Polish 4 Task 5 fix I2); a text leaf ends on
 * that edge too, in mono, through the right class (Polish 5 T2). It lives beside the leaf formatter it prints
 * (moved from AssumptionsViews.tsx by Polish 6 T5); the Stack diff and By kind import it from here.
 */
import type { AbsentView, LeafView } from "./leaf";

export function LeafCell(props: { leaf: LeafView | AbsentView }) {
  const l = props.leaf;
  if (l.kind === "absent") return <td className="num muted words">{l.text}</td>;
  return l.kind === "figure" ? <td className="num words" title={l.exact}>{l.text}</td> : <td className="mono right">{l.text}</td>;
}

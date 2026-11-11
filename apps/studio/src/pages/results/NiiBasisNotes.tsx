// apps/studio/src/pages/results/NiiBasisNotes.tsx
/**
 * The standing notes of the NII screen (spec v3.1 Section 6.1). The Flat note
 * discloses what a Flat top-up is and is not; the Runoff banner says a run with no new business is not a forecast.
 * Each prints under its own basis only, read from the label by provenance.
 */
import { basisKinds } from "../../rows/basisLabel";

export const FLAT_NOTE =
  "Flat (simple top-up): balances held at opening, 60-month fixed bullets at the par swap rate; not like-for-like. " +
  "The balance mix is static; the product mix is not. Every top-up is a fixed-rate bullet with no amortization, no reset index and no behaviour, " +
  "so floating loans roll into fixed bullets and decaying deposits are replaced by liabilities paying the swap rate.";

/** The Flat note of a run whose families carry new-volume products. */
export const FLAT_PRODUCTS_NOTE =
  "Flat with products: balances held at opening, and each family's new volume is the product its setup names (fixed or floating, bullet, level payment or " +
  "equal principal), read on the scenario's rates from the month it is made; a family with no product gets a 60-month fixed bullet at the par swap rate. " +
  "New volume carries no prepayment, decay or repricing behavior yet.";

export const RUNOFF_BANNER =
  "Runoff (no new business): balances run off with no replacement, so NII falls as the book matures. It is a measure of the book as it stands, not a forecast of earnings.";

export function BasisNotes(props: { basisLabel: string | null; products?: boolean }) {
  const k = basisKinds(props.basisLabel);
  if (!k.flat && !k.runoff) return null;
  return (
    <>
      {k.flat ? <p className="nii-note" role="note">{props.products === true ? FLAT_PRODUCTS_NOTE : FLAT_NOTE}</p> : null}
      {k.runoff ? <p className="nii-note" role="note">{RUNOFF_BANNER}</p> : null}
    </>
  );
}

# Limitations

What Studio does not model, the conventions it fixes, and the known gaps that change a result or how to read it. Grouped by topic; each item is stated once, in plain words. Where a page of the guide carries the detail, it is named.

## The bank and its data

- Quillfield Bank is synthetic. Its mix follows public FDIC aggregates and its rates are round numbers chosen so its first year lands near those aggregates; nothing is fitted to any bank's data. The deposit, prepayment and stress parameters are illustrative values, and a reading made on them says how the methods behave, not what a real bank's number would be.
- The market snapshot's Treasury curve is a public quote as of 2026-03-31. Its term funding premium and both volatility surfaces are constructed illustrative values, so every all-in and spread-consistent reading, every FTP liquidity leg and every stochastic result rests partly on a constructed input.
- The deposit history is SOFR, and the projection's first month is the one-month Treasury forward. The two differ by a few basis points at the as-of date, so the deposit models' moving average sees a small basis step at the splice, not a rate move.
- A store that imported an older version of the bank keeps it under the same id. On such a store the spread-consistent demo reads the all-in values, the funding-tenor demo reads the old FTP, and the survival path's buffer counts nothing because the positions carry no liquidity levels. The screens say so; a fresh store imports the newest version.
- Studio is a local, single-user teaching tool. It has no sign-in: names are typed and not checked. Do not load a real bank's data into it.

## Value (EVE)

- Value is run-off: the existing book pays down with nothing replacing it. New volume enters value only through the going-concern view on the Reports step, which has no independent check.
- On the risk-free basis value can fall under both the up and the down shocks. On a thinly capitalized, option-heavy book that is the mortgage option seen through a thin equity slice, not a sign error; on the all-in and spread-consistent bases a 200 bp fall adds value, so the basis changes the sign of a reading, not only its level ([`eve.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/eve.md)).
- The term liquidity premium is held static across shocks, and a loan family's discount spread is one value per family. A funding spread shock is a separate market snapshot, compared across two runs, not a scenario.
- Run-off value sits well above book equity because every cash flow is valued with no credit cost and no servicing cost.
- Effective durations are the plain bump-and-reprice around each scenario's own rates. The base-scenario durations are checked against an independent pricing; the shocked-scenario durations are not. A family duration that fails the sanity gate is left blank, not patched, and the equity duration can be blank on a run whose value is fine.
- The duration engine shifts the rate path one way and the scenario grid shifts the zero curve another; the two differ at second order on path-dependent positions, which affects the shocked-scenario durations and not the reported value.
- Key-rate durations, the value channel decomposition and the stochastic distributions are computed and not tied out by the replica. The stochastic value is on the all-in basis whatever the setup's basis.
- A custom shock vector is applied at the curve's own linear convention with no admissibility check: an extreme vector can produce negative long forwards, and the diagnostics report it rather than clamp it.

## Earnings (NII)

- A shocked scenario applies the shocked curve from the first month, the same convention as value. A shock that arrives during the year is not modeled, and a time-phased ramp is not run.
- Interest is accrued monthly on the start-of-month balance over twelve, with no day count. Income and expense are classified by the family's side in the chart of accounts.
- The SEG block covers every earning asset and every liability except the certificates of deposit; the certificates, the swap, the undrawn lines and balances held at book are outside it. Its margin is over total assets including non-earning balances, the peer margin in the data note is over earning assets, and the FTP book margin is a weighted average of transfer margins. The screens do not yet label which base a margin uses ([`nii-seg.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/nii-seg.md)).
- The SEG shock starts in the second month while the scenario shock starts in the first; SEG is therefore its own block, and its earnings figures are not the scenario grid's.
- Earnings with new volume (the finished analysis) are a management view. The regulatory change in net interest income holds the balance sheet constant. New volume can carry its family's own model (the prepayment S-curve, a constant prepayment, decay, decay with beta). The forms not carried are a mortgage on a house-price path, the straight-line, component decay and full beta deposit forms, and a credit: a loan family on one gets contractual new volume with the reason on the product, a deposit family on one starts on a fixed-rate stand-in, and the component decay and full beta forms refuse any scenario that makes new volume at all.

## Gap

- Monthly buckets on a 360-month grid, with no day weighting and no sub-monthly bucketing. The nine bands are a presentation roll-up.
- An interest-bearing deposit's repricing split uses the beta at the base rate; beta drift along the path is not in the ladder. A non-interest deposit is pure runoff.
- Under the regulatory convention the core rungs and the non-interest non-core slice are held out of the repricing ladder and appear in the fixed-rate ladder as rate-locked principal ([`gap.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/gap.md)).
- Both ladders carry principal. The interest-inclusive liquidity ladder is a switch on the setup, counts deposit interest as paid monthly although it is credited to the account, and pays CD interest with its principal; monthly-pay CDs are not modeled.
- The fixed-rate ladder is read on the base scenario only and has no node or tag arm.
- A seasoned fixed-rate loan (an origination date before the as-of date) has its cash flows re-anchored; its behavioral age is not. Seasoned floaters, mortgages and deposits are refused at import with the representation to use instead.

## FTP

- FTP is computed on the base scenario only. A shocked FTP series is refused rather than published, because the shocked earnings convention is one coupon month off the one FTP would need ([`ftp.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/ftp.md)).
- Rates and margins are stored by family, not by position.
- An interest-bearing deposit's blend holds its beta at the base rate.
- A negative transfer margin is a reading, not an error: a borrowing whose coupon sits above the matched wholesale rate funds the bank at a loss on that measure.
- The bridge reconciles to run-off net interest income. On the finished analysis the base scenario carries new-volume income, so the two differ by that income and the screen says so.
- The deposit credit's life-target, pillar and strip constructions share one pillar grid (1, 12, 36, 60 and 120 months). A straight-line runoff's credit is read on the base curve only. A credit run carries no earnings or value scenario.

## Deposits

- The regulatory convention applies one pass-through cap, one core cap and one five-year life to every deposit; the international standard sets different caps and lives by deposit class. The convention is a reference; the US has not adopted the standard ([`deposits.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/deposits.md)).
- The full beta form holds balances flat: it is a repricing model, not a decay model. A run that binds it leaves FTP out and refuses SEG, key-rate durations and the value channels.
- Component decay prices volume on a dated path, not a paid rate on a curve path; earnings, value and FTP stand aside on such a run. Past the end of its rate window the driver holds its last value.
- The deposit models' regime amplifier reads realized history that does not move with a shock, so it fires on the shock itself; the duration legs re-level that history by their bump. A family's duration and its scenario change therefore rest on different conventions.
- Certificates of deposit run on the kernel's illustrative early-withdrawal parameters, which no assumption set overrides. Their renewals are not modeled in the run; the stress ladder states a renewal share of its own.
- The published beta S-curve default a learner can pick on the Behavior step carries round illustrative textbook values, badged as an illustrative textbook default and not fitted to any data. Quillfield does not use it.

## Liquidity

- The stress ladder and the survival path are principal only, on the base rate path. Early withdrawals of certificates are the base path's; a stress does not raise them.
- The buffer counts faces, not market values, and applies no Level 2 caps. The borrowing line is a stated capacity and haircut, counted in the survival path only.
- Draws on the undrawn lines fall in the first twelve months only. The LCR reference is the dials' commitment outflow and not a full LCR; the survival path is not a regulatory metric ([`liquidity.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/liquidity.md)).
- A stress on loan repayments beyond the constant-prepayment stress speeds, new lending and intraday flows are not modeled.
- The constant-prepayment demo's ladder leaves the certificates of deposit out (its setup states no renewal share) and neither advance matures within its twelve months, so the wholesale renewal setting changes nothing there, and its buffer outlasting the severe row is not a full survival reading.
- Compare runs does not show the liquidity tables; export each run's CSV.

## Running Studio

- Plans are built under Advanced. The guided Analysis path holds one run setup; a demo opened on the guided slot would replace it, so every demo opens on Run setups under Advanced.
- A change made in an assumption set is saved as a copy; the set editor never edits a set in place. "Use this copy" puts the copy into the demo's setup as a new version; the seeded set stays in the picker.
- Open on a demo lands on the newest done run of its slot. A learner who changed the setup and launched again lands on that run; the seeded run stays in the result picker.
- The learn kit's store is `var/store-learn-quillfield`; reset moves it aside and never deletes. A store made by an older build keeps its old documents.
- Stochastic runs use the base scenario only, refuse the corrected model convention (their CD book and SEG run the earlier convention) and refuse dynamic new volume.
- Every figure the Reports step adds beyond the run-off (new volume, going-concern earnings and value, the forecast gap) has no replica target. The replica agrees with the engine on the run-off; agreement shows the two read the same definitions, not that the definitions are right. [`replica/DEFINITIONS.md`](https://github.com/chihchen22/alm-studio/blob/main/replica/DEFINITIONS.md) and [`replica/DISAGREEMENTS.md`](https://github.com/chihchen22/alm-studio/blob/main/replica/DISAGREEMENTS.md) say which conventions were read off the engine rather than derived.

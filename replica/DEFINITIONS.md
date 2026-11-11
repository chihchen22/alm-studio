# Definitions the replica rests on

Every structural model definition the replica uses, with the place it is written down: a document and its line, or a method comment at file:line. The replica was written from these descriptions, not from the engine's or the kernel's code, and it copies no constant out of code. Values that are inputs (the bank's terms, its assumption set, the market quotes, the SOFR history, the CD parameters) come from the input files and are not listed here.

Where no document stated a convention, or a document contradicted the code, the replica's first reading was compared with the engine; a disagreement was investigated and the convention written down as a method note (`docs/oss/mid-size-bank.md`, "Method notes", M1 to M11). Those rows cite the note. `DISAGREEMENTS.md` records what was found.

Three rows rest on conventions the replica takes as given, so on them it checks the engine's consistency with the convention, not the convention's correctness: R7 (the regulatory convention's four parameters, stated inputs that are the engine's defaults), S3 (the replacement-vintage rule, read from engine behavior) and S4 (the deposit vintage warmup, a stated kernel behavior). The six shocks of X4 the replica computes itself from the published formula.

## Curve and rate path

| Id | Definition | Source |
|---|---|---|
| C1 | Every par quote is a row at round(tYears x 12) months; the quote's type does not matter. | `packages/engine/src/curveBuilder/fromSnapshot.ts:9` |
| C2 | Semi-annual compounding, ACT/365: under six months a pure discount bond, DF = (1 + r/2)^(-2t); from six months to a year one coupon at maturity, DF = 1/(1 + r/2); a year and beyond a semi-annual par bond, 1 - DF(t) = (r/2) sum of DF(k/2). The tenor alone picks the branch. | `packages/engine/src/curveBuilder/rowDiscount.ts:16`, `:29` |
| C3 | Zero rates are continuously compounded, DF(t) = exp(-z t); DF(t) = 1 for t at or below 0. | `packages/engine/src/curveBuilder/solve.ts:4`; `packages/engine/src/eve/discount.ts:51` |
| C4 | The default construction interpolates log-linearly on discount factor between quote nodes, flat in zero rate outside them; each par node is solved in tenor order with the earlier nodes fixed. | `packages/engine/src/curveBuilder/solve.ts:9` |
| C5 | The built curve is that interpolator read at k/12, k = 1 to 360; between two months a zero rate is linear in time, and outside the nodes it is flat. | `packages/engine/src/curveBuilder/buildCurve.ts:23`; `packages/engine/src/curveBuilder/fastCurve.ts:12` |
| C6 | A parallel shock adds shockBp / 1e4 to every node's zero rate. | `packages/engine/src/curveBuilder/fastCurve.ts:90` |
| C7 | Rate path step k sits at time k/12; the one-month rate at step k is the simple forward (DF(t)/DF(t + 1/12) - 1) x 12. | `packages/kernel/src/math/instruments/types.ts:79`; `packages/kernel/src/math/rates/ratePath.ts:37`; `packages/kernel/src/math/rates/bootstrap.ts:48` |
| C8 | A term forward at step k is the forward par rate over [k/12, k/12 + tenor] on the semi-annual convention: below six months pure discount quoted bond-equivalent, six months to a year one coupon, a year and beyond (P1 - P2) / sum of 0.5 P(t1 + j/2). | `packages/kernel/src/math/rates/ratePath.ts:47`; `packages/kernel/src/math/rates/bootstrap.ts:71`, `:80` |
| C9 | The term liquidity premium is a continuously compounded zero spread, linear between nodes and flat outside. | `packages/kernel/public/market_public.json` (`tlp_basis`); `packages/kernel/src/math/rates/tlpCurve.ts:8` |
| C10 | All-in discounting: DF_all-in(t) = DF_rf(t) exp(-tlp(t) t), the premium held static across shocks; the risk-free basis drops the premium. | `packages/engine/src/eve/discount.ts:4`, `:10` |
| C11 | On the original convention the CD walk reads its own grid: the curve-default-1 bootstrap of the same quotes (nodes at the quotes' own tenors, linear in zero rate, the same three par branches) plus the premium, both read at k/12 for 240 months, and interpolated with numpy interp semantics. | `packages/kernel/src/math/behavioral/defaults/labCurvePublic.ts:2`, `:5`; `packages/kernel/src/math/rates/bootstrap.ts:8`, `:33`, `:213`; `packages/kernel/src/math/behavioral/cdBook.ts:268` |

## Cash-flow schedules

These rows were once S1 to S7; they became CF1 to CF7 so that S1 to S13 name only the SEG rows. No document cited the old schedule ids.

| Id | Definition | Source |
|---|---|---|
| G1 | Month m of a schedule lands in bucket m - 1 of the 360-month grid; the balance is the start-of-month balance. | `packages/kernel/src/math/instruments/types.ts:34` |
| CF1 | Interest = balance x rate / 12, a positive magnitude on either side. | `packages/engine/src/nii/computeNII.ts:12` |
| CF2 | A fixed bullet pays interest monthly and its principal at maturity; a fixed level-pay loan pays the constant annuity, the last payment clamped to the balance. | `packages/kernel/src/math/instruments/fixedLoan.ts:35`, `:63`, `:87` |
| CF3 | A floater resets on months 1, 1 + R, 1 + 2R and so on to the one-month rate at step m - 1 plus its margin; a level-pay floater re-amortizes over the remaining term at each reset. | `packages/kernel/src/math/instruments/floatingLoan.ts:7`, `:56`; `packages/engine/src/gap/gapEngine.ts:22` |
| CF4 | A swap is two bullet legs on one notional, a fixed leg and a one-month floating leg, receive positive and pay negative, the fixed leg's row first. | `packages/engine/src/swap/swapInstrument.ts:5`, `:9`, `:22` |
| CF5 | An undrawn line draws, each month, a fraction of what is still undrawn: the ramp's month-k rate, then the steady rate; a draw is negative principal with no interest; a month with no draw emits nothing. | `packages/engine/src/contracts/assumptions.ts:105`; `packages/engine/src/commitment/commitmentInstrument.ts:6`, `:19` |
| CF6 | A non-rate-sensitive balance holds its notional with no interest and no principal. | `packages/engine/src/nonRate/index.ts:6` |
| CF7 | A family's overlay replaces the behavioral block its positions' terms carry. | `packages/engine/src/projection/static/applyOverlays.ts:9`, `:67` |

## Behavior models

| Id | Definition | Source |
|---|---|---|
| P1 | A mortgage pays scheduled principal on the remaining-term level payment at its note rate, recomputed each month on the current balance. | `packages/kernel/src/math/instruments/mortgage.ts:8` |
| P2 | Its mortgage rate in month m is the 10-year forward at step m - 1 plus the securitization and primary spreads. | `packages/kernel/src/math/instruments/mortgage.ts:18` |
| P3 | Refinance S-curve: minCpr + (maxCpr - minCpr) / (1 + exp(-steepness (incentive - midpoint) / 100)), incentive = note rate less mortgage rate in bp, steepness per percentage point. | `packages/kernel/src/math/instruments/mortgage.ts:14`; `packages/engine/src/contracts/paramSchema.ts:190`, `:192`, `:193` |
| P4 | Seasoning min(1, age / ramp), age = ageMonths + m. | `packages/kernel/src/math/behavioral/prepay.ts:33`; `packages/engine/src/contracts/paramSchema.ts:194` |
| P5 | Seasonality follows the loan's age, not the calendar month: 1 - (amplitude / 100) cos(2 pi (age - 1) / 12). | `docs/oss/mid-size-bank.md:333` (M1); `packages/engine/src/contracts/paramSchema.ts:195` |
| P6 | Burnout exp(-burnoutDecay C), C the sum of the positive incentive in decimals over months 1 to m. | `docs/oss/mid-size-bank.md:334` (M2); `packages/engine/src/contracts/paramSchema.ts:196` |
| P7 | CPR is the product of the four factors, in percent; SMM = 1 - (1 - CPR/100)^(1/12) on the balance after scheduled principal. | `packages/kernel/src/math/behavioral/prepay.ts:184`; `docs/oss/mid-size-bank.md:335` (M3) |
| D1 | A deposit is split into account-size buckets by share, the shares scaled to sum to 1. | `packages/engine/src/contracts/paramSchema.ts:230` |
| D2 | Balance sensitivity g(b) = gMin + (gMax - gMin) / (1 + exp(-kappaB (ln b - ln bStar))) at the bucket's representative balance. | `packages/kernel/src/math/behavioral/nmdModel.ts:64` |
| D3 | Rate response: maxRateGrowth + (maxRateDecay - maxRateGrowth) / (1 + exp(-K (x - midpoint))), x the one-month rate level in percent for a static-rate deposit and r - D for a beta deposit. | `packages/kernel/src/math/instruments/nmd.ts:10`; `packages/kernel/src/math/instruments/nmdBeta.ts:38`, `:50` |
| D4 | Regime amplifier 1 + alpha max(0, r - MA), MA the mean of the maPeriod months strictly before. | `packages/kernel/src/math/instruments/nmd.ts:14`; `packages/kernel/src/math/rates/rateHistory.ts:24` |
| D5 | The moving average reads the warmup history, up to and including the as-of month and the last 600 months at most, followed by the path in percent. | `packages/engine/src/contracts/run.ts:92`; `docs/oss/mid-size-bank.md` ("How it is used") |
| D6 | Burnout B = exp(-lambda C), C the sum of max(0, rate response) over earlier months. | `packages/kernel/src/math/behavioral/nmdModel.ts:29` |
| D7 | Closure ramp steady + (initial - steady) exp(-t / tau), in percent a month. | `packages/kernel/src/math/behavioral/nmdModel.ts:31` |
| D8 | Bucket decay 1 - (1 - closure)(1 - max(0, response x amplifier x B x g) / 100). | `packages/kernel/src/math/instruments/nmd.ts:18`, `:19` |
| D9 | Month m reads step m - 1, closure age m - 1, and the last month pays out the balance left. | `docs/oss/mid-size-bank.md:336` (M4) |
| D10 | A static-rate deposit (`nmd`) pays its depositRate; its beta field moves neither the paid rate nor the repricing gap. | `packages/kernel/src/math/instruments/nmd.ts:56`; `packages/engine/src/gap/gapEngine.ts:39` |
| B1 | Beta deposit: beta(r) = betaMin + (betaMax - betaMin) / (1 + exp(-k (r - m))), target D = beta r, D(t) = D(t - 1) + lambda (target - D(t - 1)), D(0) the target; r and D in percent. | `packages/kernel/src/math/instruments/nmdBeta.ts:8`, `:11` |
| CD1 | Walk: hazard only off maturity; coupon balance x rate / 12 on the pre-withdrawal balance of every live cohort; run-off exits the survivor at par at maturity; the month's row is the opening balance, early plus maturity principal, and the coupon. | `packages/kernel/src/math/behavioral/cdBook.ts:47`, `:1180` |
| CD2 | Hazard h = expit(const + b1 m + bTtm z_lnTtm + bBal z_lnBal), z against the persisted constants, the logit clipped. | `packages/kernel/src/math/behavioral/cdBook.ts:17`, `:22` |
| CD3 | Moneyness m = (zero + premium) at the remaining-term tenor on the CD grid (C11 on the original convention, K2 on corrected-v1), less the contract rate. | `packages/kernel/src/math/behavioral/cdBook.ts:18`, `:297` |
| CD4 | Remaining months, floored at 1: m - w + 1 in walk month w; exit at w = m. | `packages/kernel/src/math/behavioral/cdBook.ts:354`; `docs/oss/mid-size-bank.md:337` (M5) |
| CD5 | Full-closure share expit(tb[bucket] + beta_m m + beta_b x), x the log balance standardized live over the month's off-maturity cohorts (population SD, 1.0 when one cohort or zero SD); long terms read the short intercept. | `packages/kernel/src/math/behavioral/cdBook.ts:32`, `:34` |
| CD6 | Withdrawal fraction pi = min(1, h (pFull + (1 - pFull) E[severity given partial])). | `packages/kernel/src/math/behavioral/cdBook.ts:42`, `:433` |
| CD7 | On the original convention the walk reads no rate shock: the CD book runs the same in every scenario. On corrected-v1 it reads the scenario's path (K2). | `packages/engine/src/contracts/assumptions.ts:87` |
| CD8 | A cohort's walk balance is its units times $500,000. | `docs/oss/mid-size-bank.md:215` |
| CD9 | A cohort below the minimum live balance after the month's withdrawals and maturities leaves the book with no cash flow; the minimum is $1,000 of walk balance on the original convention (the CD parameter file) and $1 on corrected-v1 (K3). | `packages/kernel/src/math/behavioral/cdBook.ts:52`; `docs/oss/mid-size-bank.md:339` (M7) |

## NII, EVE, gaps

| Id | Definition | Source |
|---|---|---|
| N1 | Asset interest is income and liability interest expense; net = income - expense; a horizon sums the first N buckets. | `packages/engine/src/nii/computeNII.ts:11`, `:25` |
| N2 | The monthly net is +interest for an asset, -interest for a liability. | `packages/engine/src/nii/computeNII.ts:31` |
| N3 | A swap family's interest is the signed net settlement: no income or expense, its net is the signed sum, added to the totals as the derivatives line, last. | `packages/engine/src/nii/computeNII.ts:103`, `:215` |
| E1 | PV = sum over buckets k of DF((k + 1)/12) x (principal + interest), on the scenario's shocked curve. | `packages/engine/src/eve/pv.ts:6`; `packages/engine/src/eve/computeEve.ts:6` |
| E2 | A swap is discounted on the risk-free curve whatever the basis, into pvDerivatives, added to EVE last. | `packages/engine/src/eve/computeEve.ts:33` |
| E3 | An undrawn line has PV 0 and is in neither side. | `packages/engine/src/eve/computeEve.ts:178` |
| E4 | A non-rate-sensitive balance is valued at par in every scenario. | `packages/engine/src/nonRate/index.ts:9` |
| E5 | EVE = pvAssets - pvLiabilities + pvDerivatives; the change is against the base, the percent change a decimal fraction of base EVE. | `packages/engine/src/eve/computeEve.ts:328` |
| G2 | Bands 0-1M, 1-3M, 3-6M, 6-12M, 1-2Y, 2-3Y, 3-5Y, 5-10Y, 10Y+ over the monthly buckets; a monthly setting adds one row per month. | `packages/engine/src/contracts/run.ts:113` |
| G3 | Repricing: a rate-locked position reprices as its principal runs off. | `packages/engine/src/gap/gapEngine.ts:14` |
| G4 | A floater reprices its outstanding balance at its next actual reset, schedule month m in bucket m - 2, principal run off before that bucket at runoff. | `packages/engine/src/gap/gapEngine.ts:17` |
| G5 | A beta deposit's beta(r0) share of each principal dollar reprices in bucket 0 and the rest at runoff; a static-rate deposit is pure runoff. | `packages/engine/src/gap/gapEngine.ts:30`, `:39` |
| G6 | A swap's fixed leg reprices at maturity and its floating leg at its next reset, signed, in the assets column. | `packages/engine/src/gap/gapEngine.ts:206`, `:506` |
| G7 | Liquidity: principal runoff by bucket; undrawn lines, balances at book and swaps are in neither ladder. | `packages/engine/src/gap/gapEngine.ts:41`, `:189`, `:204`; `packages/engine/src/swap/derivatives.ts:39` |
| G8 | Book rows: the root nodes' banded series, gap = assets - liabilities, cumulative gap the running sum. | `packages/engine/src/gap/gapEngine.ts:522` |

## FTP

| Id | Definition | Source |
|---|---|---|
| F1 | Par-matched rate r = (N - sum D(t_i) P_i) / (sum D(t_i) B_{i-1} dt), t_i = i/12, dt = 1/12. | `packages/kernel/src/math/analytics/ftp.ts:16` |
| F2 | IR against the risk-free curve, all-in against risk-free plus premium, LP = all-in - IR. | `packages/kernel/src/math/analytics/ftp.ts:9` |
| F3 | Monthly transfer rate: flat at the all-in rate for a rate-locked position; for a floater, refixed at each reset to the simple forward over the reset window from (m - 1)/12 plus the premium at the reset tenor. | `packages/kernel/src/math/analytics/ftp.ts:25`, `:130` |
| F4 | A beta deposit blends (1 - beta) of the all-in rate with beta of the one-month forward plus the one-month premium, in the headline (the forward from 0) and monthly (from (m - 1)/12). | `packages/kernel/src/math/analytics/ftp.ts:84`, `:139` |
| F5 | Coupon rate: the balance-weighted realized coupon over the position's life. | `packages/kernel/src/math/analytics/ftp.ts:103` |
| F6 | Margin: coupon - all-in for an asset, all-in - coupon for a liability. | `packages/kernel/src/math/analytics/ftp.ts:112` |
| F7 | Accrual = monthly rate x start-of-month balance / 12; coupon interest is the schedule's interest. | `packages/engine/src/ftp/computeFtp.ts:17` |
| F8 | Family rates are notional-weighted; a zero-notional row writes no rate. | `packages/engine/src/ftp/computeFtp.ts:91`, `:246` |
| F9 | Undrawn lines, balances at book and swaps are not transfer-priced; their rows stay at zero. | `packages/engine/src/ftp/computeFtp.ts:419`, `:426`, `:429` |
| F10 | Book: charges are the assets' accruals, credits the liabilities', the mismatch their difference; the bridge adds lending margin, funding margin, mismatch and the swap's net settlement. | `data/src/examples/accept/ftp.ts:14`, `:15`; `packages/engine/src/ftp/computeFtp.ts:607` |
| F11 | The FTP block builds deposits on the base scenario's deposit warmup history, the history the projection reads. | `packages/engine/src/ftp/computeFtp.ts:152` |
| F12 | The book NIM rate is the notional-weighted average of the families' margin rates over every funded family. | `docs/oss/mid-size-bank.md:338` (M6) |
| F13 | A floater with a funding tenor: IR FTP the forward over its reset window on the bond-equivalent quoting basis (C8), LP FTP the term liquidity premium at the funding tenor, all-in their sum; the monthly series refixes the forward at each reset and carries that premium throughout; the margin rate is the balance-weighted average over the loan's months of the coupon less that month's transfer rate, a family holding one reading the notional-weighted average of its positions'. | `packages/engine/src/ftp/computeFtp.ts:164` (comment); `docs/oss/mid-size-bank.md:169` |

## Feature demos

The seven seeded demo setups and their two assumption sets are an input file, `replica/inputs/feature-demos-v1.json`, which the accept check holds equal to the seed (`apps/server/src/examples/featureDemos.ts`).

| Id | Definition | Source |
|---|---|---|
| X1 | Every demo is the bank's static run-off on its seeded setup: the SOFR history warmup, NII horizons 12, 24 and 60, risk-free EVE unless the setup names another basis. | `apps/server/src/examples/featureDemos.ts:7` |
| X2 | A regulatory-grid-v1 reference `S<n>` is a parallel shift of n bp; `S0` is the base. | `packages/engine/src/contracts/scenario.ts:43` |
| X3 | A custom shock adds, to every monthly node's zero rate, the shift read at the node's tenor: linear between knots, flat beyond them. | `packages/engine/src/contracts/scenario.ts:33`; `packages/engine/src/scenario/rateEnvironment.ts:30` |
| X4 | The six standardized shocks: S(t) = exp(-t/4); parallel +/-200, short +/-300 S(t), long 225 (1 - S(t)) bp; steepener -0.65 short + 0.9 long, flattener +0.8 short - 0.6 long; at the eleven curve node tenors. The replica computes them (`alm_replica/srp.py`), runs its own, and holds the setup's vectors to them at 1e-12 bp. | `docs/oss/mid-size-bank.md:343` (M11) |
| E7 | Spread-consistent: the all-in factor times exp(-s t), s the family's one discount spread; 0 for a deposit and for a regulatory child. | `packages/engine/src/eve/discount.ts:23`, `:30` |
| X5 | A family's walYears: sum of principal[k] (k + 1) / 12 over the in-horizon principal, absent when that principal is not positive. | `packages/engine/src/contracts/results.ts:44` |
| P8 | Constant CPR on a level-pay fixed loan: scheduled B c / ((1 + c)^n - 1), SMM on the balance after it, interest B c, the CPR flat from month 1. | `packages/engine/src/loanPrepay/constantCprFixedLoan.ts:4` |
| L1 | Stress ladder roles: inflow-asset principal in months 1..12 on the base path; wholesale maturities; hys-pool and nib-pool notionals summed into two pools. | `packages/engine/src/liquidity/stressLadder.ts:6` |
| L2 | The moderate and severe rows read a constant-CPR loan at its stress speed; bau reads the base speed. | `packages/engine/src/liquidity/stressLadder.ts:20` |
| L3 | Per row and month: pool outflow = pool x rate, the pool falling by it; wholesale out = maturing x (1 - renewal); draws = undrawn face x draw rate / 12; net; cumulative. | `packages/engine/src/liquidity/stressLadder.ts:28` |
| L4 | Peak shortfall: the minimum of the cumulative series and its first month. | `packages/engine/src/liquidity/stressLadder.ts:33` |
| L5 | Survival: the first month the buffer plus the cumulative goes below 0, interpolated from the month before; none when never. | `packages/engine/src/liquidity/stressLadder.ts:139` |
| L6 | The ladder runs 12 months. | the engine's `liquidityStress.horizonMonths`; `packages/engine/src/liquidity/stressLadder.ts:53` |
| L7 | Term deposits: a `term-deposit` position's base-path principal in months 1..H, split into contractual maturities and early withdrawals; on a row that states `cdRenewal` the outflow is maturities x (1 - cdRenewal) plus the early withdrawals in full, and a row without `cdRenewal` carries no CD outflow; a setup whose rows state none writes no CD series. The renewal shares are the setup's (the bank's stated values). | `packages/engine/src/liquidity/survivalPath.ts`:9 (comment) |
| L8 | The buffer from the HQLA tags: when the setup states no buffer, each `hqla-stock` position's face times one less its `hqla-level` haircut (l1 0, l2a 15 percent, l2b 50 percent, stated inputs: the public LCR haircuts), summed in book order, written per position and by level; a position with no known level is listed and not counted, with a reason (prose the check does not compare); faces, not market values; no Level 2 caps. | `packages/engine/src/liquidity/stressLadder.ts`:24, :237 (comments) |
| L9 | A stated buffer overrides the tags. | `packages/engine/src/liquidity/stressLadder.ts`:92 (comment) |
| L10 | With the dials set, the severe row draws the dials' buffer requirement, (U99 - Ubar) x face, a twelfth of it in each of months 1 to 12: its rate is the requirement over the ladder's undrawn face, (U99 - Ubar) / (1 - Ubar); the run writes the rate the table stated and the rate it ran. | the engine source (no design note ships) |
| L11 | Draws fall in months 1 to 12 only: undrawn face x draw rate / 12, nothing after month 12. | `packages/engine/src/liquidity/survivalPath.ts`:10 (comment) |
| L12 | The commitment dials on the ladder's undrawn face, the amount undrawn now U: face F = U / (1 - Ubar); expected drawn Ubar F; undrawn U; tail drawn U99 F; buffer requirement (U99 - Ubar) F, its share U99 - Ubar; contingent charge (U99 - Ubar) / (1 - Ubar) x sB bp and that rate on U for a year; LCR reference lcrFactor x U; internal 30-day draw thirtyDayShare x requirement, its ratios to the LCR reference and to U (none when the divisor is 0). The ladder's dials carry no amount of their own; the echo carries U. Dials with delayed draws are refused in words. | `packages/engine/src/liquidity/commitmentDials.ts`:16 (comment) |
| L13 | The survival path: the severe row's recursion (L3, L7, L10, L11) carried to the setup's horizon (12 to 120 months) on the run's own base-path legs, the stress inflow line, the pools as the ladder runs them; months 1..12 are the ladder's row; each month's row carries its days, month x 365 / 12. | `packages/engine/src/liquidity/survivalPath.ts`:1 (comment) |
| L14 | Survival on the path: the ladder's crossing rule (L5) in months and in days, months x 365 / 12; the peak the most negative cumulative and its month, 0 and no month when nothing goes negative; the term-funding need the peak shortfall less the buffer, never below zero. | `packages/engine/src/liquidity/survivalPath.ts`:12 (comment) |
| L15 | The borrowing line: a second reading against the buffer plus capacity x (1 - haircut), the values the setup states; the line never enters the ladder's buffer. | `packages/engine/src/liquidity/survivalPath.ts`:3 (comment) |
| G9 | Fixed-rate ladder: fixed loans, mortgages and cd books, and a regulatory slice marked excluded, book principal in the band of its payment month (the last band open); floaters and live deposits are left out; swaps, lines and balances at book are listed uncovered. | `packages/engine/src/gap/fixedRateLadder.ts:12` |
| I1 | Per-position pv: the position's own buckets on the scenario's curve and the run's basis; a swap on the risk-free curve; a line at 0. | `apps/server/src/jobs/instrumentsPass.ts:18` |
| I2 | nii12: the side-signed interest of months 1 to 12. | `apps/server/src/jobs/instrumentsPass.ts:22`; `packages/engine/src/contracts/instruments.ts:20` |
| I3 | balance12: the balance at month 12 (bucket 11); principal12: the principal of months 1 to 12. | `packages/engine/src/contracts/instruments.ts:23` |
| I4 | walMonths: principal-weighted average life of the base scenario's in-horizon runoff, in months; absent without positive principal. | `packages/engine/src/contracts/instruments.ts:40` |
| I5 | firstRepricingMonth: the first non-zero bucket of the position's base repricing series, plus one; null when none. | `apps/server/src/jobs/instrumentsPass.ts:23` |
| I6 | Rows carry the position's family, node, side, type, notional, dimensions and discount spread as the bank file holds them. | `packages/engine/src/contracts/instruments.ts:29` |
| I7 | A non-rate-sensitive (held-at-book) position's per-position pv is its balance at the cut-off, in every scenario: the value E4 gives its family in EVE, so the rows sum to EVE for every family. | `docs/oss/mid-size-bank.md:277` |
| R1 | Regulatory: b = min(beta at r0, pass-through cap); core = min(1 - b, core cap); the rest is non-core. | `packages/engine/src/nmd/regulatoryConvention.ts:8` |
| R2 | The core is a ladder of equal rungs at the paid rate d0 = beta(r0) r0 (the parent's own rate for a static-rate deposit). | `packages/engine/src/nmd/regulatoryConvention.ts:10` |
| R3 | Rung k matures at round(24 L (k + 0.5) / rungs), ties to even. | `packages/engine/src/nmd/regulatoryConvention.ts:67`, `:80` |
| R4 | The interest-bearing non-core slice is a one-month floater at margin d0 - r0; the other is a one-month bullet at the paid rate. | `packages/engine/src/nmd/regulatoryConvention.ts:14` |
| R5 | Children keep the parent's family, node and bag, spread 0, no overlay; rungs and the non-interest-bearing slice are held out of the repricing ladder only. | `packages/engine/src/nmd/regulatoryConvention.ts:25` |
| R6 | r0 is the base path's one-month rate at step 0; the same children run in every scenario. | `packages/engine/src/nmd/regulatoryConvention.ts:154` |
| R7 | The four parameters (stated inputs, the engine's defaults, read by both sides from `replica/inputs/regulatory-convention-v1.json`; not derived by the replica) and the child names. | `docs/oss/mid-size-bank.md:340` (M8) |
| S1 | The SEG shock starts at step 1: step 0 reads the unshocked rate. | `packages/kernel/src/math/analytics/seg.ts:7`, `:62` |
| S2 | Each month's runoff is replaced by a fresh vintage, the balance held at notional. | `packages/kernel/src/math/analytics/seg.ts:38` |
| S3 | The vintage rule: its shifted path, maturity cut, coupon or note rate, and when it is made (a convention read from engine behavior; the replica checks consistency with it, not its correctness). | `docs/oss/mid-size-bank.md:341` (M9); `packages/engine/src/seg/computeSeg.ts:24` |
| S4 | On the original convention a deposit vintage's warmup is the kernel's own series, which the replica does not hold, so it refuses a SEG block on that convention. On corrected-v1 the vintage reads the run's history, unshifted (K4). | `docs/oss/mid-size-bank.md:342` (M10) |
| S5 | SEG pair: static balance at +s and -s, horizon H + 1; cum(t) = (I_up - I_dn)(month t + 1) x 12 / (2s); out(0) = sign N; out(t) = sign (N - cum(t)); per(t) = out(t - 1) - out(t). | `packages/engine/src/seg/computeSeg.ts:15` |
| S6 | Bank print: the pair at horizon H, segBank(i) = sign (NII_dn - NII_up)(month i + 1) x 12 / (2s). | `packages/engine/src/seg/computeSeg.ts:21` |
| S7 | EBP: the bank pair's existing opening balances, averaged over up and down, unsigned, assets and liabilities apart. | `packages/engine/src/seg/computeSeg.ts:28` |
| S8 | NII trio: static balance at 0, +n and -n, 12 months, signed by side. | `packages/engine/src/seg/computeSeg.ts:30` |
| S9 | Cohort-0 overlay: the existing mortgage at a flat CPR (minimum at the target, no incentive reaches the midpoint, ramp 1, no seasonality, no burnout), its vintages on the family model; the NII trio keeps the family model. | `packages/engine/src/seg/cprOverlay.ts:11`; `packages/engine/src/seg/settings.ts:11` |
| S10 | Uncovered: a cd book, a line, a swap (derivative side) and a balance held at book. | `packages/engine/src/seg/computeSeg.ts:33` |
| S11 | Peak: the largest absolute outstanding SEG over t >= 1, its sign kept, the first month on a tie. | `packages/engine/src/seg/computeSeg.ts:145` |
| S12 | nimPct = 100 x base12 / the asset notional (lines and swaps left out). | `packages/engine/src/nii/computeNII.ts:288`, `:307` |
| S13 | Retired with the corrections. It was the warmup onset from which the accept check cut the D6 family; on corrected-v1 both sides build the vintages on the run's history, so the SEG block is compared in full (D6 closed). | `replica/DISAGREEMENTS.md` D6 |

## Model convention

A run names a model convention: "book", the original convention, the behavior before the corrections, or "corrected-v1", the public default. Quillfield Bank, the coverage book and the seven demos run corrected-v1 (`replica/alm_replica/convention.py`). The replica reads each correction from text, not from engine code.

| Id | Definition | Source |
|---|---|---|
| K1 | The convention is a run option; an absent value is the original convention. The replica refuses any other value. | the engine source (no design note ships) |
| K2 | On corrected-v1 the CD walk reads the zero curve of the path it is projected on: z_k = (1 / t_k) sum over j < k of ln(1 + r_j dt), t_k = k / 12, dt = 1 / 12, r_j the path's one-month accrual rate at step j (C7), for k = 1 to the book's longest term; plus the run's TLP at t_k, held static across scenarios (C9). Offers and moneyness read that curve, so every scenario, the six shocks included, reaches the walk. A path shorter than the longest term is refused. | the engine source (no design note ships) |
| K3 | On corrected-v1 the CD minimum live balance is $1 of walk balance, the figure the kernel's CD header documents. A stated input, not derived by the replica; the original convention keeps the parameter file's $1,000. | the engine source (no design note ships) |
| K4 | On corrected-v1 a SEG replacement deposit vintage reads the run's history as the existing deposit does, unshifted and not rolled forward through the path months before its origination; the vintage rule (S3) is otherwise unchanged. | the engine source (no design note ships) |

## Deposit forms

The seven deposit-form demos (six on Quillfield's deposit desk, `examples/quillfield-deposit-desk-v1.json`, and the funding tenor on Quillfield Bank) and the desk's five sets are an input file, `replica/inputs/deposit-forms-v1.json`, which the accept check holds equal to the seed (`apps/server/src/examples/depositForms.ts`). The form values (retention, drift, coefficient, window, the full form's alpha, dampers and base state, the pillar grid, the 60-month cap) are inputs from that file and the desk; the regulatory parameters the frozen arm reads are the stated inputs of R7.

| Id | Definition | Source |
|---|---|---|
| DF1 | A form's shift is the scenario's shift of the short rate at tenor zero, percent: base 0, a parallel shift shockBp / 100, a custom vector read at tenor zero. | `packages/engine/src/nmd/fullBetaRun.ts:7` (comment) |
| DF2 | Straight-line runoff: B(t) = B(0) max(0, 1 - t / n); each month's balance the opening one, its principal one n-th (the last month what is left), interest at depositRate on the opening balance; life (n + 1) / 2 months. | `packages/engine/src/nmd/linearDecay.ts:1` (comment) |
| DF3 | Component decay: g_s = R (1 + mu0 + phi x_s), x_s = max(0, r_s + shift - rbar_s), rbar_s the mean of the lookback realized months before window month s; the shift on the window months only; past the window g holds its last value. | `packages/engine/src/nmd/componentDecay.ts:1` (comment); `docs/oss/deposit-desk.md` |
| DF4 | Component decay cash flows: B(t) = B(0) prod g; each month's opening balance, the month's runoff as principal, the remainder at maturity, interest at depositRate. | `packages/engine/src/nmd/componentDecay.ts:15` (comment) |
| DF5 | The full-runoff life: the window months one by one, then the geometric tail from the balance b after the window, b (m + q / (1 - q)), m the first month after it; the family WAL of a component decay deposit is that life in years; the savings credit reads it in months. | `packages/engine/src/nmd/componentDecay.ts:139`, `:156` (comments) |
| DF6 | The full beta form: beta_eff(r) = beta(r) clip(1 - delta v, 0, 2), delta after a rise or a fall; D*(r) = alpha + beta_eff(r) r; r the base state plus the shift, floored at 0; the direction the sign of the shift, the base reading baseLastMove; D(0) the base state's D*; unslotted, a flat balance whose paid rate closes lambda of the gap to D* each month from D(0). | `packages/engine/src/nmd/fullBeta.ts:1` (comment) |
| DF7 | Frozen slotting of a full-form deposit: b = min(beta_eff at the base state, 0.50), core min(1 - b, 0.90), five years, the same split in every scenario. | `packages/engine/src/nmd/fullBeta.ts:25` (comment) |
| DF8 | Shocked-level slotting: core 1 - beta_eff at the scenario's level, no cap, life coreLifeYears (absent 5). Under either mark the EVE book is ten equal bullet rungs at the rung months of R3 and a non-core slice leaving at month 1, every dollar at D(0); the deposit's cash flows are that book. | `packages/engine/src/nmd/fullBeta.ts:21` (comment) |
| DF9 | Shocked-level on a mixed book: a full-form deposit is marked and stays whole; every other deposit takes the regulatory split exactly as the frozen arm gives it (R1 to R6); a book with no full-form deposit is refused. | `packages/engine/src/nmd/fullBetaRun.ts:98` (comment) |
| DF10 | A bullet's par-matched rate over L months, monthly accrual on the start-of-month balance: (1 - DF(L/12)) / ((sum of DF(i/12), i = 1 to floor(L), plus stub x DF(L/12)) / 12); a fractional L carries a final stub whose accrual weight is the stub. | `packages/engine/src/ftp/replicatingPortfolio.ts:21`, `:25` (comments) |
| DF11 | Life-target pillars: a k-month pillar has life (k + 1) / 2 and earns the k-month bullet's par rate; the pillar whose life is L, or the two that bracket it, w_hi = (L - life_lo) / (life_hi - life_lo). | `packages/engine/src/ftp/replicatingPortfolio.ts:6`, `:11` (comments) |
| DF12 | The credit: the beta share overnight on a one-month bullet, (1 - beta) on the life-target pillars; rate credit the weighted rate; liquidity credit the premium at L, the bullet's all-in par rate less its benchmark par rate, on the whole balance; total their sum; the family's IR, LP and all-in rates are those three. | `packages/engine/src/ftp/replicatingPortfolio.ts:17`, `:19`, `:327` (comments); `packages/engine/src/contracts/results.ts:967` (field comments) |
| DF13 | The overlay merge writes the forms onto the terms: componentDecay and replicatingPortfolio from an nmd-decay overlay, the full form and replicatingPortfolio from a deposit-beta overlay, the decay or S-curve parameters only where the overlay states them. | the engine source (no design note ships) |
| DF14 | The straight-line class: life (n + 1) / 2, the deposit's own beta; the stock from the as-of to the longest of the runoff and the tranche pillars: the fixed-rate gap N then (1 - beta) of the runoff, the portfolio N then each pillar's straight-line stock, net their difference, the liquidity ladder the whole runoff; the readings: the premium par-matched to the runoff, whether it is within 1 bp of the credit's, and the bullet premiums at the whole months around L interpolated to L. | `packages/engine/src/ftp/replicatingPortfolio.ts:28` (comment); `packages/engine/src/contracts/results.ts:987` (field comments) |
| DF15 | A credit on the balance path or a capped life: life the full-runoff life (DF5) at the scenario's shift, or the cap; beta the deposit's own, beta_eff at the scenario's level on a full form; one liquidity leg, the whole balance at the premium of the life; a full form's paidRate D* / 100. | `packages/engine/src/ftp/replicatingPortfolio.ts:34` (comment) |
| DF16 | The scenario reading: every scenario of the run in request order, the base first and on the top level; under "shift" the tranches and the premium read on the scenario's own curve with the premium held static; with no reading named, the base scenario only. | `packages/engine/src/ftp/replicatingPortfolio.ts:413` (comment) |

Total: 144 definitions, S13 retired among them. Of them 10 (P5, P6, P7, D9, CD4, CD9, F12, R7, S3, S4) rest on a method note the tie-outs added (M1 to M11), and three (R7, K3, the haircuts of L8) are stated inputs the replica does not derive; the deposit forms' values are inputs from the seeded sets. M1 corrects documents that called the seasonal pattern a calendar one (DISAGREEMENTS D2).

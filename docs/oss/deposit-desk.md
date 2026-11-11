# Quillfield's deposit desk: data note

`examples/quillfield-deposit-desk-v1.json` is **Quillfield's deposit desk**, version 1.0: a deposits-only sub-book of Quillfield Bank (`docs/oss/mid-size-bank.md`), dated 2026-03-31 like the bank. It holds three deposits, each a family of its own, $1,200 million in all, and no assets. It exists for six feature demos: the straight-line runoff, component decay on a dated rate path, the full beta form under frozen and shocked-level slotting, and the replicating-portfolio credit, on the base scenario and at every scenario. Those forms cannot run on the whole bank. A run that binds component decay or a credit carries no NII or EVE scenario, and a run that binds the full beta form leaves FTP out and refuses SEG and key-rate durations, so on Quillfield Bank any one of them would blank the bank's main results.

Every value is a round illustrative number chosen for this file, except the SOFR values, which are the shipped public series (`examples/sofr-monthly-v1.json`, Federal Reserve Bank of New York, via FRED). None is fitted to data and none is taken from another book.

## The book

| Position | Family | Type | Balance | Terms |
|---|---|---|---|---|
| `dd-operating-1`, operating deposits | `dd-operating` | `nmd` | $300 million | non-interest (paid rate 0, beta 0), a straight-line runoff over 48 months (`linearDecay: { horizonMonths: 48 }`, `maturityMonths` 48) |
| `dd-savings-1`, savings | `dd-savings` | `nmd` | $400 million | paid 0.50 percent, beta 0, `maturityMonths` 360 |
| `dd-mma-1`, money market accounts | `dd-mma` | `nmd-b` | $500 million | the S-curve of Quillfield's money market accounts: floor 0.35, ceiling 0.75, steepness 1.0, midpoint 3.5 percent, adjustment speed 0.6; `maturityMonths` 360 |

Each deposit's decay parameters (`nmdParams`) are copied from the bank's own: the operating deposits from non-interest checking, the savings from savings, the money market accounts from money market accounts. The forms below do not read them; a deposit runs on them only where no form is bound. The liquidity roles are `nib-pool` for the operating deposits and `hys-pool` for the other two, the bank's taxonomy.

The desk is not imported by the start choices. The first Open on a Deposit desk demos card makes a test workspace, "Deposit desk", on the newest market snapshot with these positions, as "Explore the example bank" makes its own; every desk demo then opens there as a setup slot of its own.

## The forms

**Component decay (the savings book).** The balance on a dated monthly rate path: B(t) = B(0) x the product over s = 1 to t of R x (1 + mu0 + phi x x_s), with x_s = max(0, r_s + shift - the mean of the 12 realized months before month s).

| Value | Setting |
|---|---|
| Monthly retention R | 0.98 |
| Survivor drift mu0 | 0.0025 a month |
| Rate coefficient phi | -0.005 a month per percentage point |
| Benchmark lookback | 12 months |
| Series | the shipped SOFR monthly averages, April 2018 to March 2026, as stored |
| Window | April 2022 to March 2026, 48 months: projection month 1 reads April 2022 |
| Past the window | the driver holds its last window value |

A shocked scenario adds its shift to the window months only, so the benchmark stays on SOFR as it happened.

**The full beta form (the money market book).** D*(r) = alpha + beta(r) x (1 - delta x v) x r, the paid rate closing 60 percent of the gap to D* each month from the base-state rate, the short rate the base state plus the scenario's shift, balances flat.

| Value | Setting |
|---|---|
| Intercept alpha | 0.10 percent |
| Dampening after a rise | 0.3 |
| Dampening after a fall | 0.1 |
| Volatility ratio v | 1 |
| Base short rate | 3.65 percent, the March 2026 month of the shipped SOFR series |
| Last move at the base state | a fall (rates were cut through late 2025) |
| Core life (shocked-level slotting) | the prescribed five years (not set) |

At the base state beta(3.65) is about 0.565 and beta_eff about 0.508, so the paid rate starts at about 1.96 percent.

**The replicating-portfolio credit (each deposit).** Every desk credit blends the pillars 1, 12, 36, 60 and 120 months on the life-target construction:

| Deposit | Life read from | Shocked scenarios |
|---|---|---|
| Operating deposits | its straight-line runoff: (48 + 1) / 2 = 24.5 months | base only (a straight-line credit is read on the base curve) |
| Savings | its balance path, run off in full (about 49.5 months at base) | the scenario's own shifted curve, on the scenario credit demo |
| Money market accounts | a capped life of 60 months (its balances are flat) | the scenario's own shifted curve, on the scenario credit demo |

## The sets

| Set | Binds |
|---|---|
| `quillfield-desk-plain-v1` | nothing: every deposit on its own terms |
| `quillfield-desk-component-decay-v1` | component decay on the savings book |
| `quillfield-desk-full-beta-v1` | the full beta form on the money market book |
| `quillfield-desk-credit-v1` | the credit on each deposit, beside component decay on the savings book and the full form on the money market book |
| `quillfield-desk-scenario-credit-v1` | the credit on the savings path and on the capped money market life, each re-priced on the scenario's shifted curve |

## The demos

Each demo is the desk's run-off on the parallel grid (base, plus and minus 100 and 200 bp), with the SOFR history as the deposit warm-up, risk-free value and the corrected model convention, and changes only what it is about. Every figure is the engine's on the seeded setup; the cards round them and say "about".

| Demo | Set and settings | What it shows | What stands aside |
|---|---|---|---|
| A straight-line deposit runoff | plain | the operating deposits leave $6.25 million a month for 48 months, a life of 24.5 months; the desk's base value is about minus $1,099 million (it holds deposits only) | nothing |
| Component decay on a dated rate path | component decay | the savings life on the full runoff: about 4.13 years at base, 3.44 at +100 bp | NII, EVE and FTP, each with its note |
| The full beta form, frozen slotting | full beta, regulatory convention | the money market book's core held at the base date (half over five years, half in one month); its value moves by about $10.1 million under +100 bp | FTP, with its note |
| The full beta form, shocked-level slotting | full beta, shocked-level convention | the core read at each scenario's level, about 49 percent at base; its value moves by about $13.2 million under +100 bp | FTP, with its note |
| The replicating-portfolio credit | credit, base scenario only | operating credit about 4.136 percent (3.834 rate plus 0.302 liquidity), savings about 4.53, money market about 4.42 | NII and EVE, each with its note |
| The credit at every scenario | scenario credit | at +100 bp the savings credit rises to about 5.39 percent and its life falls to about 41.3 months; the money market credit rises to about 5.44 percent | NII and EVE, each with its note |

Under both full beta demos the operating and savings deposits take the standard regulatory split, ten core rungs and a one-month non-core slice, so the two runs differ in the money market book only. The regulatory convention follows an international standard, shown as a reference; the US has not adopted it.

## What the desk leaves out

- It holds no assets, so its value (EVE) is negative and its NII is the cost of its deposits. It is a teaching sub-book, not a bank.
- The credit runs and the component decay run carry no NII or EVE scenario; read those on the plain and full beta demos.
- The full beta form holds balances flat: the only setting built.
- The desk's accept lines are identities on independent anchors and the Python replica's tie-out of every demo (`replica/targets/deposit-forms-v1.json`): the values, cash flows, NII, WALs and credits, and the plain demo's gap ladders and FTP, every cell at 1e-9 relative. The FTP rows of a credit run are tied out on the credit and its three rates, not on their dollar series.

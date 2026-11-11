# Quillfield Bank: data note

`examples/mid-size-bank-v1.json` is **Quillfield Bank**, version 1.3, a synthetic bank of about $5 billion that a learner can import. "Explore the example bank" opens it with its analysis already run. It holds 29 positions in 23 product families:

- deposits of every kind;
- loans and securities;
- non-earning assets;
- borrowings;
- one interest rate swap and one undrawn commitment.

Every balance, rate and term is a round illustrative number chosen for this file. The balance sheet mix, the asset yield, the cost of funds and the margin are tuned toward public FDIC aggregates for US banks with $1 billion to $10 billion of total assets. Quillfield Bank is not any real bank and is not modeled on one. No FDIC-insured institution's name, active or inactive, contains the word "Quillfield" (BankFind institution search, 2026-11-03).

`examples/example-book-v1.json` stays as the small example (`docs/oss/example-book.md`).

## Where the numbers come from

**Source.** FDIC BankFind Suite, institution financial data (Call Report). The report date is **2026-03-31**, the bank's own as-of date. The data was retrieved on 2026-11-03 from the public API with this exact query:

```
https://api.fdic.gov/banks/financials?filters=REPDTE:20260331 AND ASSET:[1000000 TO 10000000]&fields=CERT,ASSET,CHBAL,CHBALI,CHBALNI,FREPO,SC,LNLSGR,LNLSNET,LNATRES,LNRECONS,LNRERES,LNRELOC,LNREMULT,LNRENRES,LNREAG,LNCI,LNCON,LNAG,DEP,DEPNIDOM,DEPIDOM,TRN,NTR,NTRSMMDA,NTRSOTH,NTRTIME,BRO,FREPP,OTHBOR,SUBND,ALLOTHL,LIAB,EQTOT,UC,BKPREM,INTAN,OA,TRADE,ORE,ERNAST,ERNAST5,NIMQ,INTINQ,EINTXQ,EDEPDOMQ&limit=10000&format=json
```

- `ASSET` is in thousands of dollars, so the filter selects total assets from $1 billion to $10 billion.
- The query returned 905 institutions, and every field is summed over them.
- This is the Call Report aggregate by asset size, computed from the BankFind financial data. It is not a printed Quarterly Banking Profile table.
- FDIC data is public US government data.

| Line | FDIC field | $ billions, 905 banks | Share of total assets, percent |
|---|---|---|---|
| Cash: interest-bearing balances and fed funds sold | CHBALI + FREPO | 175.7 | 6.8 |
| Cash: non-interest-bearing balances | CHBALNI | 23.7 | 0.9 |
| Securities | SC | 434.2 | 16.9 |
| C&I loans | LNCI | 276.3 | 10.8 |
| CRE: nonfarm nonresidential | LNRENRES | 572.7 | 22.3 |
| CRE: multifamily | LNREMULT | 152.8 | 5.9 |
| CRE: construction and land | LNRECONS | 134.5 | 5.2 |
| Residential 1-4 family, home equity lines included | LNRERES | 433.0 | 16.9 |
| of which home equity lines | LNRELOC | 52.3 | 2.0 |
| Consumer loans | LNCON | 92.7 | 3.6 |
| Agricultural loans and farmland | LNAG + LNREAG | 73.8 | 2.9 |
| Total loans and leases, gross | LNLSGR | 1,804.2 | 70.2 |
| Loan loss allowance | LNATRES | 23.3 | 0.9 |
| Premises and fixed assets | BKPREM | 31.9 | 1.2 |
| Intangible assets | INTAN | 26.3 | 1.0 |
| Other assets | OA | 82.6 | 3.2 |
| Total earning assets | ERNAST | 2,367.3 | 92.1 |
| Total assets | ASSET | 2,569.6 | 100.0 |
| Total deposits | DEP | 2,117.2 | 82.4 |
| Noninterest-bearing deposits, domestic | DEPNIDOM | 461.4 | 18.0 |
| Transaction accounts | TRN | 776.5 | 30.2 |
| Savings, money market deposit accounts | NTRSMMDA | 529.3 | 20.6 |
| Savings, other | NTRSOTH | 269.5 | 10.5 |
| Time deposits | NTRTIME | 519.5 | 20.2 |
| Other borrowed money | OTHBOR | 96.4 | 3.8 |
| Fed funds purchased and repos | FREPP | 16.9 | 0.7 |
| All other liabilities | ALLOTHL | 50.6 | 2.0 |
| Total liabilities | LIAB | 2,282.1 | 88.8 |
| Total equity capital | EQTOT | 287.5 | 11.2 |
| Unused commitments (off the balance sheet) | UC | 518.1 | 20.2 |

As shares of total deposits:

| Deposit type | Percent of deposits |
|---|---|
| Noninterest-bearing | 21.8 |
| Interest-bearing transaction accounts | 14.9 |
| Money market deposit accounts | 25.0 |
| Other savings | 12.7 |
| Time deposits | 24.5 |

Interest-bearing transaction accounts are an approximation: transaction accounts less noninterest-bearing deposits.

Non-earning assets come to about 5.6 percent of assets: non-interest-bearing cash, premises, intangibles, other assets and foreclosed real estate, net of the allowance.

**The peer margin.** The peer net interest margin is **3.84 percent**: four times the quarter's net interest income (`NIMQ`, $22.5 billion) over average earning assets (`ERNAST5`, $2,343.8 billion), from the same query. Relative to total assets the same figures give:

- net interest income: 3.50 percent;
- interest income: 5.23 percent (`INTINQ`);
- interest expense: 1.73 percent (`EINTXQ`).

Domestic deposit interest expense (`EDEPDOMQ`) is 1.92 percent of deposits. All five are annualized from the first quarter of 2026.

**How the round numbers were set.** Each line of the bank is its FDIC share of total assets times $5 billion, rounded. There are three departures, each a choice for a teaching book:

- Agricultural loans, farmland and loans outside the five named categories are one family, "Agricultural and other loans".
- Other liabilities (about 2.0 percent) are left out. Equity is the plug, assets less liabilities: 11.0 percent, against FDIC's 11.2 percent.
- Coupons and deposit rates were set so the bank's first-year figures land near the peer figures above (see "The bank's first year").

The swap is not from FDIC data: it is one illustrative pay-fixed hedge of the fixed-rate commercial real estate. The commitment is the FDIC unused-commitment share (20.2 percent of assets), rounded to $1,000 million, as one line.

## The bank's balance sheet

Dollars in millions, as of 2026-03-31. The test `apps/server/src/__tests__/s3a1ExampleBank.test.ts` reads this table and checks each family's total against the file.

| Family id | Line | Instrument | $ millions | FDIC share it follows, percent of assets |
|---|---|---|---|---|
| mb-non-earning | Non-earning assets: cash and due from banks 50, premises and equipment 50, other assets 150 | non-rate-sensitive, held at book | 250 | 5.6 |
| mb-cash | Fed funds sold and interest-bearing balances | fixed-loan, bullet | 400 | 6.8 |
| mb-treasuries | US Treasury securities | fixed-loan, bullet | 300 | 16.9 (all securities) |
| mb-agencies | Agency notes | fixed-loan, bullet | 150 | 16.9 (all securities) |
| mb-agency-mbs | Agency mortgage-backed securities | mortgage, pool | 400 | 16.9 (all securities) |
| mb-ci-floating | C&I loans, floating | floating-loan | 450 | 10.8 (all C&I) |
| mb-ci-fixed | C&I loans, fixed | fixed-loan, level-pay | 100 | 10.8 (all C&I) |
| mb-cre-fixed | Commercial real estate, fixed (three-year balloon and five-year amortizing) | fixed-loan | 1100 | 22.3 |
| mb-cre-multifamily | Multifamily real estate | fixed-loan, level-pay | 300 | 5.9 |
| mb-cre-construction | Construction and land loans | floating-loan | 250 | 5.2 |
| mb-resi-mortgages | Residential mortgages | mortgage | 750 | 16.9 (with home equity lines) |
| mb-heloc | Home equity lines | floating-loan | 100 | 2.0 |
| mb-consumer | Consumer loans | fixed-loan, level-pay | 200 | 3.6 |
| mb-other-loans | Agricultural and other loans | fixed-loan, level-pay | 250 | 5.5 (other loans) |
| mb-nib-checking | Non-interest checking | nmd | 900 | 18.0 |
| mb-int-checking | Interest checking | nmd-b | 650 | 12.3 (approximation) |
| mb-savings | Savings | nmd-b | 550 | 10.5 |
| mb-mma | Money market accounts | nmd-b | 1050 | 20.6 |
| mb-cds | Certificates of deposit | cd cohort book | 1050 | 20.2 |
| mb-fhlb-fixed | FHLB advances, fixed | fixed-loan liability, bullet | 150 | 4.5 (all borrowings) |
| mb-fhlb-floating | FHLB advances, floating | floating-loan liability | 100 | 4.5 (all borrowings) |
| mb-swaps | Interest rate swap, notional | swap, pay-fixed | 250 | not FDIC data |
| mb-commitments | Undrawn committed lines | commitment | 1000 | 20.2 |

Totals:

| Total | $ millions |
|---|---|
| Assets | 5,000 (non-earning 250, earning 4,750) |
| Deposits | 4,200 (84 percent of assets) |
| Borrowings | 250 |
| Liabilities | 4,450 |
| Equity | 550 |

Assets equal liabilities plus equity. The swap's notional and the undrawn lines are off the balance sheet and in neither total; the Studio's Balance step shows them on a line of their own.

**Non-earning assets.** The non-earning assets are three non-rate-sensitive balances: the position type for a balance held at book value. As a result:

- the balance holds at $250 million for the whole projection;
- it earns nothing, so it adds nothing to net interest income;
- it sits in neither the repricing nor the liquidity gap ladder;
- value counts it at par, its book value, in every scenario, so it adds the same $250 million to base and to shocked value;
- it carries no funds transfer charge, and the balance plan takes no target for it, since it does not run off.

**Liquidity roles.** Every position except the non-earning lines and the two off-balance lines carries a `liquidityRole` tag, which the liquidity stress ladder reads:

| Positions | Role |
|---|---|
| Cash and securities | `hqla-stock` |
| Loans | `inflow-asset` |
| Both checking families | `nib-pool` |
| Savings and money market | `hys-pool` |
| The two advances | `wholesale` |
| The certificates of deposit | `term-deposit` (version 1.3) |

The `nib-pool` role is the transactional pool. Part of it bears interest: interest checking ($650 million of its $1,550 million) sits there beside non-interest checking.

The book embeds its taxonomy (`mid-size-bank-tags-v1`), which version 1.3 extends with the `term-deposit` role and the `hqla-level` tag (below, "Liquidity (version 1.3)").

**Discount spreads (version 1.1).** Version 1.1 adds one field to the loans, `discountSpreadBp`: the spread over the funding curve that value adds when it is discounted on the spread-consistent basis. Every value is a round illustrative number, one per family, since the engine prices a family off one spread:

| Family | Spread, bp |
|---|---|
| C&I loans, floating and fixed (`mb-ci-floating`, `mb-ci-fixed`) | 150 |
| Commercial real estate, fixed and construction (`mb-cre-fixed`, `mb-cre-construction`) | 125 |
| Multifamily (`mb-cre-multifamily`) | 100 |
| Residential mortgages (`mb-resi-mortgages`) | 75 |
| Home equity lines (`mb-heloc`) | 150 |
| Consumer loans (`mb-consumer`) | 300 |
| Agricultural and other loans (`mb-other-loans`) | 200 |

Cash, Treasuries, agency notes and agency MBS carry none: they are valued on the funding curve alone. Deposits read no spread on any basis (the engine sets theirs to 0), and the borrowings, the swap and the undrawn lines carry none. The spread is read on the spread-consistent basis only, so the risk-free and all-in figures of version 1.0 are unchanged to the last digit: every block of the run (cash flows, NII, EVE, both gap ladders, the fixed-rate ladder, FTP, SEG and the regulatory convention) hashed the same on both versions, and the replica's targets moved only in the bank file's hash. Version 1.0 differed only by the missing field and its label. A store that imported version 1.0 keeps it under the same id; a fresh store imports the newest version, 1.3.

**Funding tenors (version 1.2).** Version 1.2 adds one field to the floaters, `fundingTenorMonths`: how long the bank funds a loan that resets every month. With it, FTP reads the rate leg at the reset tenor (the one-month forward on the curve's quoting basis) and the liquidity leg at the funding tenor (the term liquidity premium there); without it, both legs were read as one term rate over the whole principal stream. Each tenor is the position's contractual term, except the home equity lines, whose ten-year level-pay term is funded at five years, about its average life:

| Position | Funding tenor, months |
|---|---|
| C&I lines, one-month index plus 225 bp (`mb-ci-float-1`) | 36 |
| C&I term loans, one-month index plus 200 bp (`mb-ci-float-2`) | 24 |
| Construction loans (`mb-constr-1`) | 24 |
| Home equity lines (`mb-heloc-1`) | 60 |
| Two-year floating FHLB advance (`mb-fhlb-2`) | 24 |

Only the FTP block reads the field. On the bank's run-off basis, version 1.1 against version 1.2, every other block (cash flows, NII, EVE, both gap ladders) is the same to the last bit, and in the FTP block only the four floater families' rows and the book's roll-up and NIM bridge move (the core accept line `quillfield.funding-tenor.scope`):

| Family | IR FTP, 1.1 to 1.2 | LP FTP, 1.1 to 1.2 | All-in FTP, 1.1 to 1.2 | 12-month FTP margin, $ million |
|---|---|---|---|---|
| C&I floating (`mb-ci-floating`) | 3.776 to 3.740 % | 0.337 to 0.339 % | 4.113 to 4.079 % | 8.975 to 8.224 |
| Construction (`mb-cre-construction`) | 3.760 to 3.740 % | 0.300 to 0.300 % | 4.060 to 4.040 % | 6.375 to 6.055 |
| Home equity lines (`mb-heloc`) | 4.061 to 3.740 % | 0.507 to 0.450 % | 4.569 to 4.190 % | 1.012 to 0.744 |
| Floating advance (`mb-fhlb-floating`) | 3.760 to 3.740 % | 0.300 to 0.300 % | 4.060 to 4.040 % | -0.050 to 0.078 |

The four families' 12-month margin falls from about $16.3 million to $15.1 million: the liquidity leg is now charged every month at the funding tenor, not at the one-month reset. The book's mismatch center over 12 months rises from $18.89 million to $20.10 million. A store that imported version 1.1 keeps it under the same id, and there the funding-tenor demo reads the old FTP.

**Liquidity (version 1.3).** Version 1.3 adds what the liquidity stress and the survival path read. Every value is a round illustrative number chosen for this bank; none is fitted.

- The certificates of deposit carry `liquidityRole` `term-deposit`. A ladder row that states a renewal share pays them out as the run projects them: what matures, less that share, and every early withdrawal in full (the renewal share rolls contractual maturities only). A row without a share reads none, so a setup written before keeps its ladder.
- Each buffer asset carries an `hqla-level` tag. When a setup states no buffer, the ladder counts each at its face less its level's haircut, the public LCR haircuts:

| Position | Face, $ millions | Level | Haircut | Counted, $ millions |
|---|---|---|---|---|
| Fed funds sold and interest-bearing balances (`mb-cash-1`) | 400 | Level 1 | none | 400 |
| Two-year Treasury notes (`mb-ust-2y`) | 200 | Level 1 | none | 200 |
| Five-year Treasury notes (`mb-ust-5y`) | 100 | Level 1 | none | 100 |
| Agency notes (`mb-agency-3y`) | 150 | Level 2A | 15 percent | 127.5 |
| Agency MBS (`mb-mbs-1`) | 400 | Level 2A | 15 percent | 340 |
| Buffer | 1,250 | | | 1,167.5 |

  The agency notes and the agency MBS are taken as issued by the government-sponsored enterprises, which the US LCR places at Level 2A; a Ginnie Mae security would be Level 1. The faces are as-of balances, not market values, and the regulatory caps on Level 2 assets (40 percent of the stock, 15 percent for Level 2B) are not applied; here Level 2A is $467.5 million of the $1,167.5 million counted, just over that cap (by under $1 million: two thirds of the $700 million of Level 1 is $466.7 million).
- The undrawn lines (`mb-lines-1`, $1,000 million undrawn now) carry their commitment dials on the line: expected utilization (Ubar) 15 percent and tail utilization (U99) 35 percent, both shares of the commitment face. The face is the undrawn amount over (1 - Ubar), about $1,176.5 million. With the dials set, the severe row draws their buffer requirement, U99 less Ubar of the face, about $235.3 million over the first 12 months: a rate of about 23.5 percent on the $1,000 million undrawn.
- A borrowing line the bank has received, stated in the file's `liquidity` block: unused FHLB borrowing capacity of $500 million with a 20 percent haircut, $400 million counted. It counts in the survival path only, never in the ladder's buffer.
- Renewal shares for the certificates of deposit, also in the `liquidity` block: 90 percent of what matures renews under business as usual, 60 percent under moderate stress and 30 percent under severe stress.
- Interest checking stays in the `nib-pool`, the transactional pool, beside non-interest checking.

The engine reads none of the `liquidity` block or the line's dials from the book: the seeded survival-path setup reads them from the file and states them on the setup, the way a learner would. On every other demo, version 1.2 against version 1.3, every block of the run is the same to the last bit; only the run's inputs hash moves (the core accept line `quillfield.liquidity.scope`). The instrument-level results file echoes each position's tags, so it shows the new tags.

## The bank's first year

The finished analysis below gives these first-year figures. The engine computes them. The two run-off EVE figures are tied out against an independent second implementation (below, "The replica tie-out"); the 12-month figures read the balance plan's new volume, which the tie-out leaves out, so they are not.

| Measure | Quillfield Bank | Peer (FDIC, first quarter 2026) |
|---|---|---|
| Net interest income over 12 months, base scenario | $177.8 million: 3.56 percent of total assets | 3.50 percent of total assets; margin 3.84 percent of earning assets |
| Interest income | $265 million: 5.31 percent of assets | 5.23 percent |
| Interest expense | $86.9 million: 1.74 percent of assets | 1.73 percent |
| Deposit interest expense | 1.83 percent of deposits | 1.92 percent |
| Run-off EVE, base scenario | $1,318.9 million | |
| Run-off EVE, +200 bp | $1,122.7 million: down 14.9 percent | |

Run-off EVE sits well above the $550 million of book equity because the engine values every cash flow on the risk-free curve, with no credit cost and no servicing cost. Loan spreads and low-cost deposits are therefore counted at their full present value.

## Behavior: the illustrative set

The analysis binds one assumption set, version `illustrative-v1`, badged "illustrative" in the Studio. Every value is a round number chosen for this bank:

- none is taken from the kernel's defaults;
- none is fitted to any data.

The positions carry the same blocks, so the file runs without the set too.

**Prepayment (four-factor CPR).**

| Setting | Residential mortgages | Agency MBS |
|---|---|---|
| Security spread | 100 bp | 100 bp |
| Primary spread | 120 bp | 100 bp |
| WAC | 6.0 | 5.0 |
| CPR range | 3 to 50 percent | 4 to 45 percent |
| Steepness | 2.0 | 2.0 |
| Midpoint | 75 bp | 60 bp |
| Seasoning | 24 months | 24 months |
| Seasonality | 15 | 10 |
| Burnout | 0.05 | 0.05 |

**Deposit decay.**

- Non-interest checking:
  - closure of 0.6 percent a month, settling from 1.5 over 18 months, with burnout 0.05;
  - rate decay up to 2.0 percent a month and growth down to -0.5 percent a month, at slope 1.5 around a 0.5 point midpoint;
  - a 24-month moving average with amplifier 1.0;
  - four account-size buckets, half the balance up to $250k.
- Interest checking: closure 0.8, decay up to 2.5, midpoint 1.0, a commercial bucket mix. As an interest-bearing deposit its rate response reads the market rate less its paid rate.
- Savings: closure 0.5 settling from 1.0, no burnout, decay up to 5.0 at slope 0.4 around a 3.0 point midpoint, no amplifier.
- Money market: closure 0.6, decay up to 8.0, midpoint 2.5, a commercial bucket mix.

**Deposit beta (S-curve).**

| Setting | Interest checking | Savings | Money market |
|---|---|---|---|
| Beta range | 0.24 to 0.26 | 0.15 to 0.50 | 0.35 to 0.75 |
| Slope | 1.0 | 1.0 | 1.0 |
| Midpoint | 3.5 percent | 3.0 percent | 3.5 percent |
| Adjustment | 0.5 a month | 0.5 a month | 0.6 a month |

**The other lines.**

- Interest checking reprices with a beta of about 0.25: its paid rate follows 0.24 to 0.26 of the one-month rate, about 0.93 percent at the as-of date. Non-interest checking pays nothing. (Before the replica tie-out the file typed interest checking as a static-rate deposit paying 1.00 percent, whose beta field the engine does not read; `replica/DISAGREEMENTS.md` D4.)
- Certificates of deposit run on the kernel's illustrative CD early-withdrawal parameters, which no assumption set overrides today. Those parameters are hand-set round values with nothing fitted (`packages/kernel/src/math/behavioral/illustrative/cdIllustrative.ts`). Each cohort's balance is its dollars over the kernel's walk scale of $500,000 a unit.
- The undrawn lines draw 2 percent of what is still undrawn in each of the first three months, and 1 percent a month after that.

The bank does not use the kernel's own beta S-curve default (the guided Behavior step's "Published default" for an interest-bearing deposit). That default's values are round illustrative textbook values, not fitted to any data. The Studio badges it as an illustrative textbook default.

## The finished analysis

`examples/mid-size-bank-v1.analysis.json` is what "Explore the example bank" sets up, through the guided steps' own writes. Then it launches the run and opens the Reports step. The analysis uses:

- the newest market snapshot;
- the illustrative behavior set above;
- every earning family held at its opening balance, each with a round product of its own:
  - deposits as new deposits carrying their family's model;
  - mortgages prepaying by their model;
  - loans and funding contractual, at round spreads;
- the parallel rate grid: base, plus and minus 100 bp, plus and minus 200 bp;
- earnings over 60 months;
- risk-free value, with going-concern value on its 12-month default;
- the deposit history below;
- the corrected model convention (below, "The model convention").

The Run step asks you to confirm any readiness note. Explore stops there rather than confirming a note for you.

**Market.** The analysis runs on the public snapshot dated 2026-03-31 (`packages/kernel/public/market_public.json`). Its curve is US Treasury constant-maturity par yields (H.15, via FRED). Its term funding premium and both volatility surfaces are constructed illustrative values, not market quotes; the Studio's Market step says so.

## Feature demos

Home lists nine feature demos on this bank (seven on the bank's settings, the funding tenor and the survival path), each a seeded run setup that opens on the Example bank workspace as a slot of its own. Every demo is the bank's run-off on the parallel grid, with the SOFR history as the deposit warm-up and risk-free value, and changes only the settings it is about:

| Demo | What it changes |
|---|---|
| SEG and its knobs | The SEG block on: a 25 bp shock, 120 months, a 100 bp NII shock, residential mortgages prepaying at 6 percent under the rise and 20 percent under the fall in cohort 0 |
| The regulatory deposit convention | Every non-maturity deposit on the standardized convention of the international (Basel) standard, shown as a reference; the US has not adopted it |
| Spread-consistent discounting | Value on the funding curve plus each loan's discount spread (version 1.1) |
| The six standardized shocks | The base scenario and the six standardized shocks in place of the parallel grid; the USD sizes of the July 2024 recalibration (method note M11) |
| Instrument-level results | One row per position per scenario, saved beside the run |
| Constant prepayment and the stress inflow line | Consumer loans prepay at 10 percent a year (5 in stress), multifamily at 6 (3 in stress), with the liquidity stress ladder on |
| The fixed-rate gap ladder | The fixed-rate ladder on |
| The floater's funding tenor | Nothing on the setup: the common base on version 1.2, whose floaters carry a funding tenor; read Results, FTP |
| The survival path and the commitment dials | The liquidity stress ladder on version 1.3, as below; read Results, Liquidity |

Two seeded assumption sets carry the behavior: `quillfield-illustrative-v1`, the bindings of the illustrative set above, and `quillfield-constant-prepay-v1`, those plus the two constant prepayment bindings. Every value is a round illustrative number.

**What the demos leave out.** Each card's Details repeat the line that applies to it.

- SEG covers every earning asset (the cash, the securities and the loans) and every liability except the certificates of deposit: the non-maturity deposits and the two advances. The certificates of deposit ($1,050 million), the swap, the undrawn lines and the non-earning balances are outside it, so its constant-balance earnings and its NIM are for that part of the bank.
- NIM bases differ. The SEG block's NIM is its 12-month earnings over total assets ($5,000 million, the $250 million of non-earning balances included). The peer margin above, 3.84 percent, is on average earning assets. The FTP book margin is a third figure, a weighted average of the families' transfer margins (method note M6). The Studio does not yet label which base each figure uses.
- The regulatory convention applies one core cap (90 percent) and one five-year life to every deposit. The international standard sets different caps and lives for retail transactional, retail non-transactional and wholesale deposits. On this bank the non-core slices come to about 31 percent of the non-maturity deposits ($990 million of $3,150 million): 10 percent of non-interest checking, 25 of interest checking, 39 of savings and 50 of money market. The core rungs and the non-interest slice stay at today's paid rate; the interest-bearing non-core slice floats one for one with the one-month rate. The certificates of deposit are not split.
- The constant-prepayment demo's stress ladder leaves out the certificates of deposit: they carry the `term-deposit` role since version 1.3, but that setup states no renewal share, so they enter nothing. Neither advance matures within its 12 months (they mature at months 36 and 24), so the wholesale renewal setting changes nothing there. The buffer outlasting the severe row by about $19 million is therefore not a full survival reading.
- The instrument-level results value the three non-earning balances ($250 million) at par, their opening balance, in every scenario, as value (EVE) does, so every family's rows sum to its value. A results file made before that change (file schema 1.0.0) reads 0 for them, and the Instruments screen says so in one line; run the setup again to value them at par.
- A store that imported version 1.0 of this bank keeps it under the same id. On that store the spread-consistent demo reads the all-in values. A fresh store reads version 1.3.
- Six more demos run on Quillfield's deposit desk, a deposits-only sub-book of this bank (`docs/oss/deposit-desk.md`): the straight-line runoff, component decay on a dated rate path, the full beta form under frozen and shocked-level slotting, and the replicating-portfolio credit, on the base scenario and at every scenario.

**The survival-path demo.** The setup is the common base with the liquidity stress ladder on, as follows. The stress rates are the Studio's round illustrative starting table:

| Row | Savings and money market outflow, a month | Checking outflow, a month | Wholesale renewal | Draw rate | CD renewal |
|---|---|---|---|---|---|
| Business as usual | 0.4 percent | 0.1 percent | 100 percent | 0 | 90 percent |
| Moderate stress | 4 percent | 0.8 percent | 60 percent | 12 percent | 60 percent |
| Severe stress | 8 percent | 1.5 percent | 20 percent | 25 percent, replaced by the dials' requirement, about 23.5 percent of the undrawn lines | 30 percent |

- The buffer is left to the HQLA tags: $1,167.5 million.
- The undrawn face is the lines' $1,000 million, the amount undrawn now; the dials read it and derive their face, about $1,176.5 million. The dials' other values: a funding spread of 50 bp, the LCR factor of a credit line to a non-financial company, 10 percent (12 CFR 249.32(e)(1)(iii)), and one twelfth of the tail draw in the first 30 days, the even spread's first month.
- The survival path runs the severe row for 24 months with the FHLB line.

On this build about $680 million of certificates of deposit matures in the first year and about $59 million is withdrawn early. The severe ladder's cumulative net outflow reaches about $1,768 million at month 12, so the buffer lasts about 6.7 months (about 203 days); the term-funding need at the path's peak is about $1,010 million. The survival path carries the row to month 24, where the shortfall peaks at about $2,178 million in month 23. With the FHLB line counted, $1,567.5 million in all, the buffer lasts about 10.6 months (about 322 days), and the need is about $610 million. The dials' LCR reference, 10 percent of the $1,000 million undrawn now, is $100 million; it is shown beside the path and is not a full LCR. The contingent charge is about 11.76 bp, about $1.18 million a year on the undrawn lines. These figures hold on a fresh store; a store that imported an older version of the bank has no HQLA levels, and the page says its buffer counts nothing.

## The deposit history: SOFR monthly averages

`examples/sofr-monthly-v1.json` holds the Secured Overnight Financing Rate as monthly averages of daily values, in percent: April 2018 (the first full month of the series) to March 2026, 96 months.

- **How it is used.** The analysis hands the series to every deposit as the moving-average warm-up: the run option `nmdWarmup`, kind `history`, read up to the as-of month, March 2026. Without it, the deposit models would read the kernel's own hand-typed series, which stops in September 2025, six months before the snapshot. Since an earlier build step a new analysis reads this series too, whenever it covers the workspace's date, and the Market step names the history its deposits read.
- **Basis at the splice.** The history is SOFR, and the projection's month 0 is the one-month Treasury forward. The two differ by a few basis points at the as-of date: SOFR averaged 3.65 percent in March 2026, against 3.71 percent for the path. The regime moving average therefore sees a small basis step at the splice, not a rate move.
- **Source.** Federal Reserve Bank of New York, Secured Overnight Financing Rate [SOFR], retrieved from FRED, Federal Reserve Bank of St. Louis: https://fred.stlouisfed.org/series/SOFR. The monthly averages are FRED's own frequency aggregation: https://fred.stlouisfed.org/graph/fredgraph.csv?id=SOFR&fq=Monthly&fam=avg&cosd=2018-04-01&coed=2026-03-31. Retrieved 2026-11-03.
- **Terms of use.** The New York Fed's Terms of Use (https://www.newyorkfed.org/privacy/termsofuse, last updated 2023-06-09) grant a non-exclusive license to use, copy and distribute its content for personal or business purposes. The things a republisher must carry are:
  - the reference-rate notice, which says the New York Fed is not responsible for the republication and does not endorse it;
  - the copyright notice;
  - for a product named after a rate, a non-affiliation disclaimer, which does not apply here.

  The file's `notice` field carries the first two. FRED marks the series "Copyrighted: Citation Required", and the file and this note cite it as FRED suggests.

## The model convention

Every analysis, demo and new setup on this bank runs the corrected model convention (`modelConvention: "corrected-v1"`). A setup saved before it runs the original convention and says so in one line. The corrections that touch this bank:

- **The certificates of deposit react to the scenario.** Their early withdrawals read the scenario's zero curve plus the snapshot's funding spread, at each cohort's remaining term. Before, they read a fixed curve of their own and ignored every shock. When rates rise, more depositors break their CDs early: the run-off book's 12-month interest expense falls, and the CD book's value as a liability rises (+200 bp: about $1.9 million more on the risk-free basis, so run-off EVE at +200 bp is about $1.9 million lower). With every balance held flat, the money that leaves is replaced at the higher rate, so the finished analysis's 12-month NII at +200 bp is about $0.7 million lower.
- **They read the snapshot's market at base too.** The snapshot's curve sits close to the fixed curve they read before, so base figures move by about $1,100 of 12-month NII and $100 of EVE.
- **The minimum live balance is $1**, as the kernel documents, not $1,000. No CD cohort on this bank comes near either.
- **SEG vintages read the SOFR history.** In the SEG demo, interest checking's replacement deposits read the SOFR history its existing balance reads, not the kernel's series: its outstanding SEG moves by up to $49,439 (month 120) and its up-shock constant-balance NII by up to $2.64 a month.

## The replica tie-out

`replica/` is a second implementation of the engine's deterministic core in Python and numpy. It shares only input files with the engine: this bank, the analysis's assumption set, the market snapshot, the SOFR history and the CD parameters below. It shares no code and no constant. It writes `replica/targets/quillfield-v1.json`, and the core accept check `python-replica-tie-out` compares the engine with every cell of it at 1e-9 relative.

The tie-out runs the bank on the run-off basis: base and the parallel plus and minus 100 and 200 bp shocks, the SOFR history as the deposit warmup, no new volume. It covers:

- the projection of every position;
- run-off NII by month and over 12 and 24 months;
- run-off EVE on the risk-free and the all-in basis;
- the repricing and the liquidity gap;
- FTP of the existing positions.

A second, synthetic coverage book (`replica/inputs/coverage-v1.json`) is tied out the same way, on base, +100 and -100, -200 and -300 bp. It carries the paths this bank does not reach: young and part-year-aged mortgages inside the seasoning ramp, strong burnout, quarterly and annual floaters, an undrawn line with a month of no draw, a CD cohort below the minimum live balance, and an interest-bearing deposit with a live beta and the regime amplifier on.

`replica/DEFINITIONS.md` lists every model definition the replica rests on and where it is written down. `replica/DISAGREEMENTS.md` records each disagreement and its cause.

**The CD parameters.** The cd cohort book runs on the illustrative CD early-withdrawal set, version 3, run-off arm only. The replica reads the same values from `replica/inputs/cd-illustrative-v3.json`:

| Setting | Value |
|---|---|
| Hazard: intercept, moneyness slope, log remaining-term slope, log balance slope | -5.5, 40, 0.40, 0.20 |
| Standardization: log remaining months mean and SD; log walk-dollar balance mean and SD | 2.2 and 0.90; 15 and 1.0 |
| Full-closure share: short and medium intercepts, moneyness slope, live log-balance slope | 0.85, 0.60, 10, -0.30 |
| Expected severity of a partial withdrawal | 0.40 |
| Logit clip; minimum live balance | 15; $1,000 |
| Term buckets for the full-closure intercept | 1 to 12 months short, 18 and 24 medium, 36 to 60 long (long reads the short intercept) |

**Method notes.** What the tie-out pinned, one line each. M1 corrects documents that called the pattern a calendar one; the others were stated nowhere before. Three of them are conventions the replica takes as given, so on those parts the replica checks the engine's consistency with the convention, not the convention's correctness: M8's four parameters (stated inputs, the engine's defaults), M9 (read from engine behavior) and, on the original convention only, M10 (a stated kernel behavior). M11's shocks the replica computes itself:

- M1. Mortgage seasonality follows the loan's age, not the calendar month: the factor is 1 - (amplitude / 100) x cos(2 pi (age - 1) / 12), where age is the loan's age in month m (`ageMonths` + m), lowest at ages 1, 13, 25 and so on and highest six months later. On this bank every loan is a whole number of years old at 31 March, so speeds trough in April and peak in October, not in the winter and summer a calendar pattern would give.
- M2. Mortgage burnout: the factor is exp(-burnoutDecay x C), where C sums max(0, note rate - mortgage rate), in decimals, over months 1 to m, the current month included.
- M3. Mortgage prepayment: the single monthly mortality is 1 - (1 - CPR / 100)^(1/12), applied to the balance left after the month's scheduled principal.
- M4. Deposits: month m reads the path at step m - 1 (time (m - 1) / 12), its closure ramp at age m - 1, and its moving average over the maPeriod values before that step; the last month pays out the balance left.
- M5. CD cohort walk: in walk month w a cohort with m months to maturity is off maturity while w < m, with m - w + 1 months remaining, and exits in full at w = m.
- M6. FTP book NIM rate: the notional-weighted average of the families' FTP margin rates, over every family with a funded notional, assets and liabilities together.
- M7. CD minimum live balance: a cohort whose balance is below the minimum after the month's withdrawals and maturities leaves the book with no cash flow; its coupon for that month is still paid. The balance it held is not repaid, so the book's principal falls short of its notional by that amount (the coverage book shows it on a $500 cohort; this bank's cohorts never reach the minimum). The minimum is $1,000 of walk balance on the original convention; on the corrected convention it is $1, so the $500 cohort runs to maturity and principal is conserved.
- M8. Regulatory deposit convention: the marginal pass-through is capped at 0.5 and the core share at 0.9, and the core is ten equal rungs with a prescribed average life of 5 years (maturing at months 6, 18, ..., 114). These four numbers are stated inputs to the convention, not outputs of it: they are the engine's defaults, read off the engine (its children and its defaults constant) before any document stated them, and `replica/inputs/regulatory-convention-v1.json` restates them so that both sides read the same inputs. The replica does not derive them; it checks that the engine applies them as written here. Each rung is a bullet at the paid rate d0 = beta(r0) r0, where r0 is the base path's one-month rate at step 0. The non-core slice is a one-month floater at margin d0 - r0 for an interest-bearing deposit, and a one-month bullet at the paid rate otherwise. Children are named `<parent>-core-1` to `<parent>-core-10` and `<parent>-noncore`.
- M9. SEG replacement vintage (a convention read from engine behavior; the replica checks consistency with it, not its correctness): the runoff of month k, from the existing book and every live vintage, is reinvested at the end of month k into one vintage, which reads the scenario's shocked path from step k and earns from month k + 1. Its maturity is the parent's (a mortgage's original term), cut to the months left in the walk. A fixed loan's coupon is the parent's plus the shocked forward par rate at step k less the base forward at step 0, both at the parent's term. A mortgage's note rate is the shocked 10-year forward at step k plus the securitization and primary spreads, at age 0. A floater or a deposit keeps the parent's terms. No vintage is made in the walk's last month.
- M10. SEG deposit vintages: on the corrected convention, which the demos run, a replacement vintage of a deposit reads the run's history, unshifted, as the existing deposit does, and the replica builds it the same way, so the SEG block ties in full. On the original convention the vintage is built on the kernel's own warmup series instead (`replica/DISAGREEMENTS.md` D6, closed on the corrected convention); the replica does not model that convention's SEG.
- M11. The six standardized shocks (the Basel standard's interest rate risk in the banking book shocks, SRP31, as recalibrated in July 2024; that recalibration raised the USD long-rate shock from 150 to 225 bp), at tenor t in years, with S(t) = exp(-t / 4): parallel +/-200 bp; short rate +/-300 S(t) bp; long rate 225 (1 - S(t)) bp; steepener -0.65 |short| + 0.9 |long|; flattener +0.8 |short| - 0.6 |long|. The magnitudes are the USD ones; the standard is an international reference, which the US has not adopted. They apply at the eleven curve node tenors of the market snapshot (1 month to 30 years), linear between knots and flat beyond. The replica evaluates this formula itself (`replica/alm_replica/srp.py`) and runs its own vectors; the vectors the seeded setup carries must equal them to 1e-12 bp.

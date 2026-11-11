# Explore the bank

Step 1 of Start here opens Quillfield Bank with its analysis already run. This page says what that analysis is, how to read it, and what to change first.

## The idea

A bank's balance sheet is a collection of promises with different timing: loans that pay back on a schedule or early, deposits that can leave any day but mostly do not, borrowings with fixed dates, a swap, and lines of credit nobody has drawn yet. Asset and liability management (ALM) asks what that collection earns over the next year or two (net interest income), what it is worth today (economic value), and when the money comes back (gap). Each question has its own method, and the methods share one set of projected cash flows. Studio runs all of them on one bank so you can see how a single assumption, say how fast savings balances leave when rates rise, moves every answer at once.

Quillfield Bank is a synthetic bank of about $5 billion. Its balance sheet mix follows public FDIC Call Report aggregates for US banks with $1 billion to $10 billion of assets, its coupons and deposit rates are round numbers chosen so its first year lands near those banks' figures, and nothing in it is fitted to any real bank's data ([`DATA.md`](https://github.com/chihchen22/alm-studio/blob/main/DATA.md)). It is the right size to be legible: every position has a name you can read, and every total traces to a handful of rows.

## What the finished analysis is

The analysis you land on runs through the nine steps of the Analysis path: Market, Balance sheet, Behavior, New volume, Calibration, Simulation, Scenarios, Run, Reports. Each step holds one choice the run reads.

The market is a public snapshot dated 2026-03-31: a Treasury par-yield curve, a constructed term funding premium and constructed volatility surfaces (the Market step labels which is which). The behavior is an illustrative assumption set of round values: a prepayment S-curve on the mortgages and agency MBS, a decay model on each deposit, and a beta S-curve on each interest-bearing deposit. New volume holds every earning family at its opening balance, each replaced by a round product of its own, so earnings are read on a going-concern basis. The scenarios are a parallel grid: base, plus and minus 100 bp, plus and minus 200 bp. Earnings run over 60 months; value is read on the risk-free curve, with going-concern value on its 12-month default. The deposits read the shipped SOFR history as the moving-average warm-up their decay models need.

The Run step asks you to confirm any readiness note before it launches. Explore stops there rather than confirming one for you; on a fresh store there is nothing to confirm, and `npm run learn` has already run it.

## Reading the Reports step

Reports shows the headline figures and links to each Results screen under Advanced: Dashboard, Earnings (NII), Value (EVE), Gap and liquidity, Compare runs. Two bases sit side by side, and the distinction matters for every number on this site.

The run-off basis lets the existing book pay down with nothing replacing it. It is the basis value (EVE) and both gap ladders are read on, apart from the going-concern view and the forecast gap, and it is the basis every demo on Start here runs. On it the bank earns about <!-- num target=quillfield-v1 cell=nii.S0.totalNet12 scale=million dp=1 unit=$ -->$173.1 million of net interest income over the first year at base, and is worth about <!-- num target=quillfield-v1 cell=eve.risk-free.S0.eve scale=million dp=0 unit=$ -->$1,319 million on the risk-free curve. A parallel rise of 200 bp takes about <!-- num target=quillfield-v1 cell=eve.risk-free.S200.deltaEveVsBase scale=million dp=0 unit=$ sign=abs -->$196 million off that value, <!-- num target=quillfield-v1 cell=eve.risk-free.S200.deltaEvePct scale=percent dp=1 sign=abs -->14.9 percent.

The going-concern basis adds the new volume the plan makes. Its first-year net interest income sits a little above the run-off figure, because maturing balances are replaced at today's rates rather than left to run down, and going-concern value adds what the first year's new business is worth on the discount curve. These figures have no independent check yet (below), so I describe them here in words and let the screen show them.

Run-off value sits well above the bank's $550 million of book equity because every cash flow is valued on the risk-free curve with no credit cost and no servicing cost, so loan spreads and low-cost deposits are counted at their full present value. The Value (EVE) page discusses what each discount basis does to that reading.

## What is checked, and what is not

The run-off figures this guide quotes are tied out against an independent Python replica ([`replica/`](https://github.com/chihchen22/alm-studio/tree/main/replica)), written from the method descriptions and sharing no code with the engine: the projection of every position, run-off NII by month, run-off value on the risk-free, all-in and spread-consistent bases, both gap ladders, the fixed-rate ladder, SEG, the FTP of the existing positions, the deposit forms and credits, the stress ladder and the survival path, every cell at one part in a billion. Every demo on Start here is tied to a target (the desk demos and the funding tenor share one file). Not tied out: the effective and key-rate durations, the value channels, attribution, the stochastic runs, and the figures the Reports step adds beyond the run-off (new volume, going-concern earnings and value, the forecast gap). That is why the guide quotes none of them.

Agreement between two implementations shows they read the same documents the same way; it does not show the documents are right. [`replica/DEFINITIONS.md`](https://github.com/chihchen22/alm-studio/blob/main/replica/DEFINITIONS.md) lists every definition the replica rests on, and [`replica/DISAGREEMENTS.md`](https://github.com/chihchen22/alm-studio/blob/main/replica/DISAGREEMENTS.md) records each disagreement found while it was built and what was done about it.

## Instrument-level results

Every total on the Results screens is a sum of positions, and the Instruments screen lets you see the parts: one row per position per scenario, with its value, its 12-month earnings, its balance and the principal it pays back in the first year. The rows sum to Value (EVE) family by family, the three non-earning balances included (they are valued at par in every scenario, as the value screen values them). Sort the grid by value change under the +200 bp scenario and the long fixed-rate assets, the mortgage pools first, rise to the top; mind the sign on a liability row, where a fall in value is a gain to the bank, and the non-interest checking row sits close behind them for that reason.

## Start here on this page

**Step 1, Explore the bank.** Open lands on the Reports step. Change any step of the Analysis path, such as the scenarios, and run it again from the Run step. A good first change is the Scenarios step: add a steepener, run again, and read Value (EVE) and Earnings (NII) on the new run. Compare runs puts two runs side by side.

**More demos, Instrument-level results.** On Run setups store only Total Liabilities and Equity, press Save as a new version, launch it, and the grid keeps only the deposit and borrowing rows. The saved file gets smaller too, which is the trade a large book faces.

## What this page does not cover

The method behind each figure is on its own page: [`eve.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/eve.md) for value, [`nii-seg.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/nii-seg.md) for earnings and the sensitivity equivalent gap, [`gap.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/gap.md) for the two ladders, [`ftp.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/ftp.md) for transfer pricing, [`deposits.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/deposits.md) for the deposit models and conventions, [`liquidity.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/liquidity.md) for the stress ladder and the survival path. Stochastic runs (a Hull-White or BGM rate model on the base scenario), key-rate durations and the attribution screens are in Studio but are not tied out and are not described in this guide. Known gaps that change a reading are collected in [`limitations.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/limitations.md).

# ALM Studio

ALM Studio is a free, open-source tool for learning bank asset and liability management by doing it. It runs a whole bank's analysis on a synthetic bank, Quillfield Bank: earnings (net interest income), value (economic value of equity), the sensitivity equivalent gap, the repricing and liquidity ladders, funds transfer pricing, the deposit models and conventions, and a liquidity stress with a survival path. Those results (run-off earnings, value on each basis, both gap ladders, SEG, FTP, the deposit forms, the stress ladder and the survival path) are checked against an independent Python replica; durations, key rates, the value channels, attribution, the stochastic runs and the going-concern figures are not.

It is for people who want to understand how these measures are made, not only what they say: analysts new to a treasury or ALM desk, students, model validators, and practitioners who have used a vendor system for years and want to see the mechanics with nothing hidden. Nothing in it is a production system, and no real bank's data should be loaded into it.

## Start

You need Node 22 or newer and a terminal at the repository root. Then:

```
npm install
npm run learn
```

`npm run learn` builds the Studio once, starts a local server on its own store with Quillfield Bank's analysis already run, runs every demo once, and prints the address to open (port 8787, or the next free port if that one is busy). The first start takes about fifteen seconds on a fresh store; a second start keeps what the store holds. Stop with Ctrl+C. `npm run learn:reset` moves the store aside and never deletes it.

The Studio opens on Home. The first card is Start here: a numbered path of eight steps on Quillfield Bank, then More demos, every demo once. Each step says what it teaches in one line, what Open shows, and one thing to change and run again; a "More about this demo" box under each step gives a few plain sentences and names the guide page that explains the method. Below Start here are two start choices: Start a new analysis, which opens an empty workspace, and Explore the example bank, which sets Quillfield up from scratch (on a store that already holds it the button reads Start a fresh example bank, with a link to continue the existing one).

The eight steps, in teaching order:

1. Explore the bank: a whole bank's analysis, finished, one step at a time.
2. Six regulatory shocks (EVE): how the bank's value moves under the six standardized rate shocks.
3. Earnings sensitivity (SEG): how much of the bank acts like a fixed-rate balance, and what a rate move does to earnings.
4. Fixed-rate repricing ladder (gap): when the money on fixed-rate loans, mortgages and CDs comes back, band by band.
5. Floater funding tenor (FTP): how a floating loan's funding tenor sets the liquidity part of its transfer price.
6. Full beta, frozen slotting (deposits): how a money market deposit's paid rate follows the short rate, and what that does to its value.
7. Replicating-portfolio credit (deposit FTP): what a deposit's funding is worth.
8. Survival path and dials (liquidity): how long liquid assets last in a severe stress, and what the undrawn lines draw.

The method guide under [`docs/guide/`](https://github.com/chihchen22/alm-studio/tree/main/docs/guide) has one page per topic, each with the idea, the method as Studio computes it, a worked example on Quillfield with checked numbers, and what to try on each step: [`explore.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/explore.md), [`eve.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/eve.md), [`nii-seg.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/nii-seg.md), [`gap.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/gap.md), [`ftp.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/ftp.md), [`deposits.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/deposits.md), [`liquidity.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/liquidity.md). [`docs/guide/limitations.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/limitations.md) lists what is not modeled and the conventions that change a reading.

## What Studio can and cannot do

It runs a bank's existing book on a rate scenario grid (parallel shocks, the six standardized shocks, custom shock vectors) with behavioral models on the mortgages, deposits and certificates of deposit, and reports earnings, value, both gap ladders, the fixed-rate ladder, SEG, FTP, the liquidity stress and the survival path, each on a Results screen with a CSV export. The guided Analysis path takes a book from import to a report in nine steps and holds new volume for a going-concern earnings and value view. Run setups, assumption sets, scenarios, compare runs and the stochastic rate models (Hull-White and BGM on the base scenario) sit under Advanced.

It does not fit a model to data: every parameter on this site is an illustrative value, and the Behavior step offers published defaults, badged as not fitted to your book. It does not run a daily grain, a time-phased shock, an intraday liquidity view or a market-value buffer. Plans (balance plans and new-business rules beyond the guided path) are built under Advanced; there is no plan-composer page in this release. The figures the Reports step adds beyond the run-off (new volume, going-concern value, the forecast gap) are computed but have no independent check yet. [`docs/guide/limitations.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/limitations.md) has the full list.

## For developers

The repository is an npm workspace. [`packages/kernel`](https://github.com/chihchen22/alm-studio/tree/main/packages/kernel) is the frozen instrument and rate math (vendored, hash-verified); [`packages/engine`](https://github.com/chihchen22/alm-studio/tree/main/packages/engine) is the aggregation, scenario and reporting layer over it, a pure library; [`packages/ai`](https://github.com/chihchen22/alm-studio/tree/main/packages/ai) is the typed tool surface and MCP server ([`docs/ai-native.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/ai-native.md)); [`packages/harness`](https://github.com/chihchen22/alm-studio/tree/main/packages/harness) is the plan layer and stage-graph executor, with its catalog under [`docs/harness/`](https://github.com/chihchen22/alm-studio/tree/main/docs/harness); [`packages/reader`](https://github.com/chihchen22/alm-studio/tree/main/packages/reader) reads results; [`apps/server`](https://github.com/chihchen22/alm-studio/tree/main/apps/server) is the local platform (file store, job runner, HTTP routes); [`apps/studio`](https://github.com/chihchen22/alm-studio/tree/main/apps/studio) is the React front end; [`apps/viewer`](https://github.com/chihchen22/alm-studio/tree/main/apps/viewer) is the older workbench; [`data`](https://github.com/chihchen22/alm-studio/tree/main/data) holds the synthetic generator and the acceptance battery; [`replica/`](https://github.com/chihchen22/alm-studio/tree/main/replica) is the Python replica; [`examples/`](https://github.com/chihchen22/alm-studio/tree/main/examples) holds Quillfield Bank, its deposit desk, the small example book, the SOFR history and two CSV position templates; [`docs/`](https://github.com/chihchen22/alm-studio/tree/main/docs) holds the architecture note, the import formats, the data notes and the guide.

Build and check:

```
npm run typecheck          every workspace
npm test                   the vitest suite
npm run accept             the acceptance battery: anchors, goldens and the replica tie-out
npm run docs:check         every Quillfield number in the public docs against the replica's targets
npm run build -w apps/studio
```

The spreadsheet reader, SheetJS `xlsx` 0.20.3, installs from the SheetJS download site (cdn.sheetjs.com) rather than the npm registry, whose last release of it carries public advisories.

`npm run accept` compares the engine with the replica's committed targets ([`replica/targets/`](https://github.com/chihchen22/alm-studio/tree/main/replica/targets)) cell by cell at one part in a billion and runs no Python. To check the targets for drift you need Python 3.12 with numpy ([`replica/requirements.txt`](https://github.com/chihchen22/alm-studio/blob/main/replica/requirements.txt)): `ALM_PYTHON=/path/to/python3.12 npm run replica:check`. To regenerate them after a deliberate model change, `$ALM_PYTHON replica/run.py --write`, then the check. [`replica/DEFINITIONS.md`](https://github.com/chihchen22/alm-studio/blob/main/replica/DEFINITIONS.md) lists every definition the replica rests on and [`replica/DISAGREEMENTS.md`](https://github.com/chihchen22/alm-studio/blob/main/replica/DISAGREEMENTS.md) every disagreement found and its cause. Never edit a target to match the engine; the target is the check.

To run Studio on a fresh store with nothing run yet, `npm run studio`. Step 1 runs first there (it makes the bank's workspace); each bank demo then opens on Run setups one launch away, and the deposit desk's demos make their own workspace on first Open. To bring your own bank, start a new analysis and import positions on the Balance sheet step as JSON (the canonical form, the chart of accounts travelling with the positions) or CSV (one row per position against a stored chart of accounts); [`docs/import-formats.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/import-formats.md) has both contracts, and [`examples/positions-template-v2.csv`](https://github.com/chihchen22/alm-studio/blob/main/examples/positions-template-v2.csv) is a starting file. Validation reports every error at once with its row and field. Keep real data off this tool.

I designed and reviewed Studio; much of the code was written with AI coding assistants (Claude), and the core results, the run-off earnings, value, gap, FTP and liquidity figures of every demo, are checked against an independent Python replica. Where the replica and the engine disagreed, the disagreement and its resolution are on record.

## Data and license

Quillfield Bank is synthetic and modeled on no real bank. The market curve is public Treasury data and the deposit history is public SOFR data; the funding premium and volatility surfaces are constructed. [`DATA.md`](https://github.com/chihchen22/alm-studio/blob/main/DATA.md) lists every source and its terms, and [`NOTICE`](https://github.com/chihchen22/alm-studio/blob/main/NOTICE) carries the attributions those terms require.

ALM Studio is released under the Apache License, Version 2.0 ([`LICENSE`](https://github.com/chihchen22/alm-studio/blob/main/LICENSE)). Copyright 2026 Chih Chen.

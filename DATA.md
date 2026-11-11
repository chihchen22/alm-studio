# Data

Every data source in ALM Studio, what it is used for, and the terms it comes with. The rule throughout: a market quote is named with its source and date; everything else is an illustrative value chosen for teaching, stated as such, and fitted to nothing.

## Quillfield Bank ([`examples/mid-size-bank-v1.json`](https://github.com/chihchen22/alm-studio/blob/main/examples/mid-size-bank-v1.json))

Quillfield Bank is a synthetic bank of about $5 billion, dated 2026-03-31, with 29 positions in 23 product families: deposits of every kind, loans and securities, non-earning assets, borrowings, one interest rate swap and one undrawn commitment. It is not any real bank and is not modeled on one. No FDIC-insured institution's name, active or inactive, contains the word "Quillfield" (BankFind institution search, 2026-11-03).

Its balance sheet mix, asset yield, cost of funds and margin are tuned toward public FDIC aggregates: the FDIC BankFind Suite's institution financial data (Call Report) for the 905 US banks with $1 billion to $10 billion of total assets at the 2026-03-31 report date, retrieved from the public API on 2026-11-03 with the exact query recorded in [`docs/oss/mid-size-bank.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/oss/mid-size-bank.md). Each line of the bank is its FDIC share of total assets times $5 billion, rounded, with the departures a teaching balance sheet needs: agricultural and other loans are one family, other liabilities are left out with equity as the plug, and coupons and deposit rates are set so the bank's first year lands near the peer figures (net interest income 3.50 percent of assets, a margin of 3.84 percent of earning assets). The swap is one illustrative hedge, not FDIC data. FDIC data is public US government data. The query returned one row per institution, which were summed; only the sums are used, and no institution's figures are reproduced.

Every balance, rate, term, spread, funding tenor, liquidity tag, utilization dial, haircut and renewal share in the file is a round illustrative number. The bank's behavioral assumption set (`illustrative-v1`, badged "illustrative" in Studio) is round values chosen for this bank: a prepayment S-curve on the mortgages and the agency MBS, a decay model on each deposit and a beta S-curve on each interest-bearing deposit. None is taken from a kernel default and none is fitted to data. The certificates of deposit run on the kernel's illustrative early-withdrawal parameters, hand-set round values recorded in the data note. The data note lists every value.

## Quillfield's deposit desk ([`examples/quillfield-deposit-desk-v1.json`](https://github.com/chihchen22/alm-studio/blob/main/examples/quillfield-deposit-desk-v1.json))

A deposits-only sub-book of Quillfield Bank, dated the same day: three deposits, $1,200 million in all, no assets. It exists so that the deposit forms that cannot run on the whole bank (component decay, the full beta form, the replicating-portfolio credit) can be shown one at a time. Every value is a round illustrative number copied from the bank's own deposits or chosen for the form, except the SOFR values its component decay form reads, which are the shipped public series below. [`docs/oss/deposit-desk.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/oss/deposit-desk.md) is its data note.

## The small example book ([`examples/example-book-v1.json`](https://github.com/chihchen22/alm-studio/blob/main/examples/example-book-v1.json))

A small synthetic balance sheet of 11 positions, $650 million of assets, that a learner can load on the Balance sheet step of a new analysis. Every figure is a round illustrative number; its mortgage, checking and savings positions carry the kernel's published default behavioral blocks, copied into the file so it is self-contained. Nothing in it is fitted to any bank's data. [`docs/oss/example-book.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/oss/example-book.md) describes it.

## The market snapshot ([`packages/kernel/public/market_public.json`](https://github.com/chihchen22/alm-studio/blob/main/packages/kernel/public/market_public.json))

The snapshot is dated 2026-03-31. Part of it is a market quote and part is constructed, and the Market step labels which is which.

The curve is a market quote: US Treasury constant-maturity par yields from the Federal Reserve Board's H.15 release, retrieved through FRED (Federal Reserve Bank of St. Louis), bootstrapped on the Treasury convention (semi-annual par bonds, bond-equivalent yield at one year and beyond) with the published one-month bill as the short node. It is the risk-free discount basis of every value reading and the rate path of every projection.

The term funding premium and the two volatility surfaces (a short-rate volatility surface in the shape of a cap grid, and an at-the-money long-yield option grid; the Treasury basis has no caps or swaptions of its own) are constructed illustrative values, anchored to realized levels for teaching and not market quotes. Every all-in and spread-consistent value, every FTP liquidity leg and every stochastic result rests partly on them. The loan families' discount spreads live in the bank file, not the snapshot, and are round values too.

## The deposit history ([`examples/sofr-monthly-v1.json`](https://github.com/chihchen22/alm-studio/blob/main/examples/sofr-monthly-v1.json))

The Secured Overnight Financing Rate as monthly averages of daily values, in percent, April 2018 (the first full month of the series) to March 2026, 96 months. The deposit models read it as the moving-average warm-up their rate response needs, up to the as-of month; the component decay form on the desk replays it from April 2022 to March 2026 as its dated rate path. Note that the history is SOFR while the projection's first month is the one-month Treasury forward, so the moving average sees a basis step of a few basis points at the splice.

Source: Federal Reserve Bank of New York, Secured Overnight Financing Rate [SOFR], retrieved from FRED, Federal Reserve Bank of St. Louis, https://fred.stlouisfed.org/series/SOFR, retrieved 2026-11-03. The monthly averages are FRED's own frequency aggregation.

Terms: the New York Fed's Terms of Use (https://www.newyorkfed.org/privacy/termsofuse) grant a license to use, copy and distribute the content for personal or business purposes, and require a republisher to carry the reference-rate notice (the New York Fed is not responsible for the republication and does not endorse it) and the copyright notice. The file's `notice` field carries both, and so does [`NOTICE`](https://github.com/chihchen22/alm-studio/blob/main/NOTICE). FRED marks the series "Copyrighted: Citation Required", and the file, this page and [`NOTICE`](https://github.com/chihchen22/alm-studio/blob/main/NOTICE) cite it as FRED suggests. Three replica input files embed copies of the same series as the dated rate path of the seeded setups they hold ([`replica/inputs/deposit-forms-v1.json`](https://github.com/chihchen22/alm-studio/blob/main/replica/inputs/deposit-forms-v1.json), [`replica/inputs/feature-demos-v1.json`](https://github.com/chihchen22/alm-studio/blob/main/replica/inputs/feature-demos-v1.json) and [`replica/inputs/survival-path-v1.json`](https://github.com/chihchen22/alm-studio/blob/main/replica/inputs/survival-path-v1.json)); they are the same data under the same terms, [`NOTICE`](https://github.com/chihchen22/alm-studio/blob/main/NOTICE) names them, and [`replica/inputs/NOTICE`](https://github.com/chihchen22/alm-studio/blob/main/replica/inputs/NOTICE), beside them, carries the notice and the citation for those files.

## The rate history ([`packages/kernel/public/rate_history_public.json`](https://github.com/chihchen22/alm-studio/blob/main/packages/kernel/public/rate_history_public.json))

A monthly history of month-end US Treasury constant-maturity par yields, October 2008 to March 2026, at eleven published tenors (one month to 30 years; the series DGS1MO, DGS3MO, DGS6MO, DGS1, DGS2, DGS3, DGS5, DGS7, DGS10, DGS20 and DGS30 of the H.15 release, retrieved through FRED), with six intermediate tenors interpolated linearly in maturity. It is read generically as the risk-free benchmark history: FTP and the deposit models' regime calculations read it at the snapshot month, and its end month is held equal to the snapshot's. Its term-funding series is constructed: the benchmark curve plus a hand-set round spread schedule, a stand-in for a wholesale funding curve and not market data. The file's provenance notes say so, and say that it holds no SOFR, no policy rate and no proprietary series, although one of its keys is named `sofr_term` for an older reason.

## Macro series ([`apps/server/data/macro/`](https://github.com/chihchen22/alm-studio/tree/main/apps/server/data/macro))

Two public monthly series ship as reference histories on one seeded market under Advanced (`macro-demo-v1`), beside three authored house-price projections: the FHFA purchase-only house price index for the United States (FRED `HPIPONM226S`, index January 1991 = 100, seasonally adjusted; the file runs from January 1991 to July 2026) and the BLS unemployment rate (FRED `UNRATE`, percent, seasonally adjusted; the file runs from January 1948 to September 2026), both retrieved from FRED on 2026-10-08 as revised series, not point-in-time vintages. When the market is seeded each history is cut at the market's as-of month, March 2026, and the house price index is rebased so that March 2026 reads one. No run reads a history: the one model that reads a macro series, the house-price feeder on a mortgage prepayment model, reads an authored projection mapped in the assumption set. `macro_source_manifest.json` beside the files records the URL, the retrieval date, the SHA-256 and the known gaps. FRED marks both series "Public Domain: Citation Requested", and [`NOTICE`](https://github.com/chihchen22/alm-studio/blob/main/NOTICE) cites them as FRED suggests. Quillfield Bank and its demos read neither.

## Illustrative stress and convention values

The liquidity stress rates (deposit outflows, wholesale and CD renewal shares, draw rates), the commitment dials (expected and tail utilization, funding spread), the borrowing line's capacity and haircut, and the regulatory deposit convention's parameters (a pass-through cap of 0.5, a core cap of 0.9, a five-year core life in ten rungs) are round values stated on the setup or in the data note. The liquidity haircuts on the buffer (none for Level 1, 15 percent for Level 2A, 50 percent for Level 2B) are the public US LCR haircuts. The six standardized rate shocks are the USD sizes of the international standard after its July 2024 recalibration (parallel 200 bp, short rate 300 bp, long rate 225 bp), computed from the published formula; the standard is an international reference that the US has not adopted.

## Published defaults a learner can pick

The Behavior step of a new analysis offers the kernel's published default parameters for prepayment, deposit decay and deposit repricing, each badged as a default not fitted to your book. The beta S-curve default's values are round illustrative textbook values, not fitted to any data, and Studio badges it as an illustrative textbook default. Quillfield Bank does not use it.

## What is a quote and what is not

| Input | Kind | Source or basis |
|---|---|---|
| Treasury par-yield curve, 2026-03-31 | market quote | H.15 constant-maturity Treasury series via FRED |
| SOFR monthly history, April 2018 to March 2026 | market data | Federal Reserve Bank of New York via FRED |
| Treasury CMT rate history, October 2008 to March 2026 | market data | H.15 constant-maturity series via FRED; its term-funding series is constructed |
| House price index and unemployment rate, monthly | public statistics | FHFA and BLS via FRED, public domain, citation requested |
| Quillfield Bank's balance sheet mix | tuned to public aggregates | FDIC BankFind Call Report aggregates, 905 banks, 2026-03-31 |
| Every balance, rate, term and spread in the bank files | illustrative | round values chosen for teaching |
| Behavioral parameters (prepayment, decay, beta, CD early withdrawal) | illustrative | round values; nothing fitted |
| Term funding premium and volatility surfaces | constructed | illustrative values in the snapshot |
| Stress rates, dials, renewal shares, borrowing line | illustrative | round values stated on the setup |
| LCR haircuts, six standardized shocks | public rule | US LCR haircuts; the international standard's USD shock sizes |
| Published behavioral defaults on the Behavior step | illustrative | the kernel's defaults: round textbook values, nothing fitted |

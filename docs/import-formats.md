# Import formats

Date: 2026-08-02.

The platform takes three kinds of input: a position book as JSON (canonical), a
position book as CSV (assisted), and a market snapshot workbook. Validation is
loud and total on every path: a rejected import returns HTTP 422 with EVERY
error found, each naming the row and the field, never just the first failure.
After the structural sweep, every position is dry-instantiated through the
engine's instrument factory so kernel domain errors (a non-finite rate, an
impossible term, a bad behavioral parameter) surface at import time with the
offending position id attached, rather than at minute 40 of a run. Kernel
messages pass through verbatim.

The 422 body shape:

```json
{ "error": { "code": "VALIDATION", "message": "import rejected: N validation errors",
             "detail": { "errors": [ { "row": 3, "positionId": "p2", "column": "coupon",
                                       "message": "..." } ] } } }
```

`row` is the CSV physical line number (header is line 1) or, for JSON, the
1-based index into `positions[]`. `column` is the field or CSV column name when
the error is field-scoped; dry-instantiation errors carry the kernel message
with `row` and `positionId` only.

Ids everywhere (portfolio, position, family, COA node, coaId) must match
`^[A-Za-z0-9._-]{1,64}$`: ids double as store filenames.

---

## 1. JSON position import (canonical)

`POST /api/portfolios/import` with a full `PortfolioSpec`
(`packages/engine/src/contracts/position.ts`):

```json
{
  "id": "my-book",
  "label": "My bank, 2026-03-31 snapshot",
  "asOf": "2026-03-31",
  "coa": { "schemaVersion": "1.0.0", "nodes": [ ... ], "families": [ ... ] },
  "positions": [
    { "id": "p1", "familyId": "fixed-loans", "coaNodeId": "coa-fixed-loans",
      "terms": { "id": "p1", "type": "fixed-loan", "notional": 1000000,
                 "maturityMonths": 60, "originationOffsetMonths": 0,
                 "amortType": "level-pay", "side": "asset", "coupon": 0.05 } }
  ]
}
```

The COA travels with the positions and the spec is stored verbatim after
validation. Checks, all of them collected before any rejection:

- portfolio header: id shape, non-empty label, ISO `asOf` (never defaulted);
- COA integrity: unique node ids, parents exist, families unique, each family's
  `instrumentType` one of the five kernel types or the three engine-side ones
  (`swap`, `cd`, `commitment`, `non-rate-sensitive`), a `derivative` family
  exactly when the type is `swap`, a commitment family on the `asset` side,
  each family attached to an existing leaf node;
- per position: unique id, `terms.id` equal to the position id, `familyId`
  declared in `coa.families`, `coaNodeId` an existing leaf that matches the
  family's declared leaf, `terms.type` equal to the family's `instrumentType`
  (the mapping), every scalar term field present with the right type,
  enums in their closed sets, every number finite (JSON can smuggle Infinity
  via `1e999`; it is caught), parameter blocks present and deep-finite;
- dry instantiation of every structurally clean position through
  `makeInstrument`.

Unrecognized extra fields inside `terms` are stored verbatim and reported as
warnings, not errors. Two engine-extension fields the engine reads are checked
instead: `fundingTenorMonths` on a floating loan (a whole number of
months from 1, the funding tenor its liquidity charge is read at) and
`linearDecay` on an nmd deposit (`{ "horizonMonths": n }`, n equal to the
deposit's `maturityMonths`). Either on another terms type is a row error.

A position's `dimensions.liquidityRole` tag, which the liquidity stress ladder
reads, must be one of `inflow-asset`, `hqla-stock`, `hys-pool`, `nib-pool` or
`wholesale`; any other value is a row error against `dimensions.liquidityRole`
(on the CSV path, `dim.liquidityRole`).

## 2. CSV position import (assisted)

`POST /api/portfolios/import?format=csv&coaId=...&label=...` with CSV text, and
an optional `&taxonomyId=...` for the tag columns described below.
One file, one row per position. CSV cannot carry a chart of accounts, so the
import targets a stored COA by `coaId`; full custom books use the JSON path.
The portfolio id, label, and as-of date come from the request, not the file;
the platform never invents an as-of date.

The parser is RFC 4180: quoted fields, doubled-quote escapes, embedded commas
and newlines, CRLF or LF. The header row is required and case-sensitive.
Unknown columns are errors. A cell in a column that does not apply to the
row's `terms_type` must be blank; a value there is an error, not a silent
ignore. `side` may be left blank, in which case it is filled from the owning
family's side and the fill is reported as a warning; a stated side that
contradicts the family is an error.

Object-typed kernel fields (the parameter blocks listed per type below) cannot
be expressed as CSV cells. The CSV path fills them from the kernel's published
defaults, mirroring the synthetic generator's stance: a position embeds no
authored behavior, and the run's assumption set is the swappable behavioral
layer. Every default fill is reported as a warning. A parameter block with no
registered kernel default is a loud refusal directing the book to the JSON
path, never a guessed value.

### CSV column contract

The table below is GENERATED from the kernel term interfaces
(`packages/kernel/src/math/instruments/types.ts` and the five instrument
sources) by `apps/server/src/intake/columnContract.ts`. Do not edit it by
hand: the doc-sync test (`importFormatsDoc.test.ts`) fails when this region
and the kernel sources disagree. Regenerate with:

```
npx tsx -e "import { renderColumnContractMarkdown } from './apps/server/src/intake/columnContract.ts'; console.log(renderColumnContractMarkdown());"
```

<!-- BEGIN GENERATED: csv-column-contract -->
Meta columns (every row): `position_id`, `family_id`, `coa_node_id`, `terms_type`.

#### Shared term columns (from `InstrumentTermsBase`)

| column | type | required | description |
|---|---|---|---|
| `label` | string | no |  |
| `notional` | number | yes | Notional / current balance at instrument-time-zero, in dollars. |
| `maturityMonths` | number | yes | Months to legal maturity from instrument-time-zero. |
| `originationOffsetMonths` | number | yes | Origination month offset relative to model time-zero (negative = seasoned). |
| `amortType` | `level-pay` \| `bullet` | yes | Amortization style. |
| `side` | `asset` \| `liability` | no | Balance-sheet side. "asset" (default when omitted) means the bank earns the coupon and pays a funding charge; "liability" means the bank pays the coupon and earns a funding credit. Affects the FTP-margin sign convention so that all rows in the FTP decomposition table report positive franchise value. |

#### `fixed-loan` (`FixedLoanTerms`)

| column | type | required | description |
|---|---|---|---|
| `coupon` | number | yes | Fixed annual coupon, decimal (e.g. 0.05 = 5%). |

#### `floating-loan` (`FloatingLoanTerms`)

| column | type | required | description |
|---|---|---|---|
| `indexTenorMonths` | number | yes | Index tenor in months (1 = 1M SOFR). For Phase 2 only 1M is supported. |
| `margin` | number | yes | Static margin over the index, decimal annualised. |
| `resetFrequencyMonths` | number | yes | Reset cadence in months (1 = monthly). |

#### `mortgage` (`MortgageTerms`)

| column | type | required | description |
|---|---|---|---|
| `noteRate` | number | yes | Locked note coupon, decimal annualised (e.g. 0.065 = 6.50%). |
| `originalTermMonths` | number | yes | Original loan term at origination, in months (typically 360). |
| `originalBalance` | number | yes | Original loan balance at origination, for display / context only. |
| `ageMonths` | number | yes | Months elapsed since origination at simulation time-zero. |

Parameter blocks (not CSV columns; filled from kernel defaults by the CSV path, authored via the JSON path or the run's assumption set): `cprParams` (`MBSParams`).

#### `nmd` (`NMDTerms`)

| column | type | required | description |
|---|---|---|---|
| `depositRate` | number | yes | Static deposit rate the bank pays, decimal annualised (0 for Non-IB). |
| `beta` | number | yes | Deposit-rate beta of a plain deposit, a decimal from 0 to 1. No gap ladder reads it: a plain deposit runs off as its decay model says. Only the replicating-portfolio funding credit reads it, as the share of the balance that reprices at once. |

Parameter blocks (not CSV columns; filled from kernel defaults by the CSV path, authored via the JSON path or the run's assumption set): `nmdParams` (`NMDParams`).

#### `nmd-b` (`NMDBetaTerms`)

No type-specific scalar columns.

Parameter blocks (not CSV columns; filled from kernel defaults by the CSV path, authored via the JSON path or the run's assumption set): `sCurve` (`BetaSCurveParams`), `nmdParams` (`NMDParams`).
<!-- END GENERATED: csv-column-contract -->

The engine does not read `indexTenorMonths`; a floating loan resets on the
one-month benchmark plus its margin unless it names a market rate index. A
floating-loan names one through the JSON terms field `rateIndexId`,
for example `"rateIndexId": "prime-demo"`: a lowercase id of letters, digits and
single hyphens, starting with a letter, at most 40 characters. The named index's
own tenor governs, and the run refuses the book if the market it runs on does
not carry that index. `rateIndexId` on any other terms type is a row error. The
CSV path does not carry the field yet.

### Engine-side types: swaps, cd cohort books, commitments

The three types the engine builds beside the frozen kernel are admitted on
both paths. Their columns are stated here by
hand, because they live in engine sources, not kernel ones; the engine's own
validators stay the domain authority, and each refusal is reported against the
field it is about. The shared columns above apply to every one of them;
`amortType` is always `bullet` and `originationOffsetMonths` always 0.

| terms_type | family | columns | notes |
|---|---|---|---|
| `swap` | side `derivative`, instrumentType `swap` | `direction` (`pay-fixed` \| `receive-fixed`, required), `fixedRate` (required), `floatMargin`, `resetFrequencyMonths` | `side` stays blank: a swap's side is its family's. The floating leg reads the one-month benchmark plus its margin. Off the balance sheet: the import's asset and liability sums leave it out. |
| `cd` | side `liability`, instrumentType `cd` | `termMonths` (the cohort's original term: 1, 2, 3, 6, 9, 12, 18, 24, 36, 48 or 60), `contractRate` | One CSV row per cohort; rows sharing a `position_id` are one book, which takes the first row's place, label and tags. On a cohort row `notional` is the cohort's dollars and `maturityMonths` its months to maturity. The book's notional is the sum, its maturity the longest, and each cohort's balance is its dollars over the kernel's walk scale (500,000 dollars a unit), so the kernel walk runs at the cohort's own size. A JSON book states `cohorts: [{ termMonths, monthsToMaturity, balance, contractRate }]` itself. |
| `commitment` | side `asset`, instrumentType `commitment` | `drawRampRates` (fractions of what is still undrawn, month 1 first, joined by `\|`), `drawSteadyRate` | `notional` is the undrawn capacity and `maturityMonths` the months until the line expires. Both draw cells blank is no draw path: the line draws nothing until an assumption set binds a draw model, and the import says so. Off the balance sheet. A JSON book states `draw: { rampRates, steadyRate }`. |

A non-rate-sensitive balance is a `non-rate-sensitive` row on an asset or liability
family of that instrument type: `notional` is its book value, `maturityMonths` how long it is held (360 on the shipped
template), `amortType` `bullet` and no other column. It is held at book: no interest, no runoff, in neither gap ladder,
valued at par in every scenario, with no transfer charge, and a balance plan or new-volume product may not target it.
Use it for cash and due from banks, premises and other assets, or other liabilities.

A floating-rate liability is an ordinary `floating-loan` row on a liability
family. On the CSV path a floater may also carry `fundingTenorMonths`, and an `nmd`
row may carry `linearDecayMonths`: a straight-line runoff over that
many whole months, equal to the row's `maturityMonths`, which the import writes as the
JSON path's `linearDecay: { "horizonMonths": n }` and checks the same way. The Balance
sheet's position drawer shows either term where a position carries it.

### Tag columns

A CSV book tags its positions through `dim.<id>` columns against a STORED
dimension taxonomy, which the import targets by `taxonomyId` exactly as it
targets a stored chart of accounts by `coaId`. A CSV file cannot carry a
taxonomy any more than it can carry a chart of accounts, and the platform
invents neither. There is no route that creates a taxonomy: the store seed
writes the shipped one, and a practitioner with a custom taxonomy uses the JSON
path, as a custom chart of accounts does today.

One column per authorable dimension, named `dim.` plus the dimension's id. The
authorable set is whatever the taxonomy the request names declares, less the two
ids that may NOT be authored because the engine derives them from the owning
family: `productFamily` and `side`. A taxonomy that declares those two still
declares them; they simply have no legal column. The shipped `demo-dimensions-v1`
taxonomy declares eight authorable dimensions, so its legal columns are
`dim.managementView`, `dim.regulatoryView`, `dim.rateType`,
`dim.behavioralClass`, `dim.governanceTier`, `dim.disposition`, `dim.segment`
and `dim.behavioralClasses`, the last of which is its only multi-valued one. `behavioralClasses` IS authorable, as on the
JSON path: a position's own list adds classes to its family's, and can never
remove one.

Cell rules:

- A blank cell (after trimming) is an ABSENT tag, never a default and never an
  empty value. A row whose `dim.` cells are all blank gets no tag bag at all, so
  a tagless CSV book imported with no `taxonomyId` is byte-identical to one
  imported before tag columns existed. A request that passes a `taxonomyId` and
  no tag column is not: its spec carries the resolved `taxonomy`, which is the
  point of passing one.
- A cell in a column whose dimension declares `multiValued: true` is split on
  `|` and each piece is trimmed. An empty piece (`a||b`, `a|`) is kept as the
  empty string, so the engine refuses it under rule D3 naming the row and the
  column rather than silently dropping it.
- A cell in a single-valued column is stored verbatim as one string. A `|` in it
  is part of the value, and the taxonomy's declared values decide its fate. A
  multi-valued tag whose value must contain a `|` has no escape; use the JSON
  path.

Three header refusals, reported together with the other header errors, each
against the header line and naming the offending column:

- a `dim.` column in a request that passed no `taxonomyId`:
  `column "dim.x" needs a taxonomy; pass taxonomyId=`;
- a `dim.<id>` the taxonomy does not declare, or one of the two derived ids: the
  ordinary unknown-column error, whose list of legal columns now includes the
  legal `dim.` columns;
- a duplicate `dim.` column: the ordinary duplicate-column error.

A `taxonomyId` with no `dim.` column in the file is accepted: the book carries
the taxonomy and the positions carry no tags, which is exactly what the JSON
path produces for the same book.

Tag validation is the ENGINE's and only the engine's. The taxonomy rides on the
assembled portfolio spec and `validateDimensions` runs rules D1 to D4 over it,
the same rules the JSON path runs. Nothing in the CSV parser checks a tag value.
A rule that names a position's tag is reported against the `dim.<id>` column the
author wrote rather than the `dimensions.<id>` JSON field; a rule that names the
taxonomy document itself is reported against `taxonomy.<id>`, because it is not
a column of this file.

There is no CSV EXPORT of tags. The run exports carry results, not positions, so
a tagged book does not round-trip through CSV.

### Example

```csv
position_id,family_id,coa_node_id,terms_type,notional,maturityMonths,originationOffsetMonths,amortType,coupon
p1,fixed-loans,coa-fixed-loans,fixed-loan,1000000,60,0,level-pay,0.05
p2,fhlb,coa-fhlb,fixed-loan,250000,24,-3,bullet,0.045
```

### Seasoning: `originationOffsetMonths` semantics

The kernel base terms carry `originationOffsetMonths` but the kernel itself
ignores it. The engine rules it the seasoning re-anchor directive
(`packages/engine/src/portfolio/seasoning.ts` is the single source of truth):

- **`0` (the default): the terms are the remaining representation, anchored at
  the portfolio as-of date.** `notional` is the current balance,
  `maturityMonths` the remaining term, and the cashflow stream starts the month
  after as-of. This is how the synthetic generator emits every position and
  how a **seasoned mortgage** is imported: remaining terms plus the mortgage's
  native `ageMonths` (which the kernel consumes for the CPR seasoning ramp and
  burnout state — exact for both timing and behavior).
- **Negative: the terms are the original (origination-anchored)
  representation.** The instrument originated `-offset` months before as-of
  with the stated original notional and term; the engine drops the elapsed
  months and shifts every surviving cashflow bucket by the offset. In the
  example above, `p2` is a 24-month bullet FHLB advance originated 3 months ago: its
  principal matures 21 months after as-of and its ladder bands measure from
  as-of, not from origination. **Supported for `fixed-loan` terms only**, where
  the stream is path-independent and the shift is exact. `floating-loan`,
  `mortgage`, `nmd`, and `nmd-b` refuse a nonzero offset with a typed error
  naming the correct representation (floaters and deposits: remaining
  representation at offset 0; mortgages: `ageMonths`).
- **Positive: refused.** A forward-start position does not belong on the
  static book; future originations are the dynamic new-business module's.

Import refuses, row by row against the `originationOffsetMonths` column with the
engine's own message, every position the engine's `seasoningOffsetOf` refuses, and
setup validation and launch refuse a stored book that still holds one.

One honest boundary, disclosed in the limitations list Section 5: the run
re-anchors a seasoned fixed-loan. Every other nonzero or forward-start
offset is refused at import and at setup validation with the engine's message.
Behavioral age is not re-anchored by the offset: the shift moves
where cashflows land, not how old the kernel thinks the instrument is.

## 3. Market snapshot workbook

`POST /api/market/import-workbook` with raw `.xlsx` bytes and an
`X-Filename` header. Parsing is the kernel's existing `importMarketWorkbook`
(`packages/kernel/src/math/rates/importWorkbook.ts`), the 4-sheet workbook layout:
`SOFR_OIS_Curve` (Term | InstType | Mid), `FHLB_Curve` (Term | Mid),
`Cap_Volatility` and `ATM_Swaption_Volatility` (banner row, then an Expiry
header row, then expiry rows). Conventions are the kernel's: decimal per-annum
rates and vols rounded to 1e-7, tenor labels normalized (`1 MO` to `1M`),
cap strikes absolute with a separate explicit ATM column, and the Term LP
derived as FHLB minus SOFR with 1D pinned to zero. The as-of date comes from a
`_YYYYMMDD` filename suffix when present, else from the request's stated
fallback date (ISO, required; the platform never invents a date).

A successful import returns and stores the kernel `ImportSummary` (node and
surface counts, calibration date, date provenance) beside the snapshot.
Kernel refusals (missing sheet, non-numeric cell, non-positive Term LP,
mismatched tenor sets) come back verbatim as 422 errors.

Data constraint: imported snapshots are local, internal artifacts in
the 127.0.0.1-bound store. The intake module ships no market-data fixture; its
tests build a synthetic in-memory workbook from invented numbers.

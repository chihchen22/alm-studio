# The example input book

`examples/example-book-v1.json` is a small synthetic balance sheet a learner can load: 11 positions in nine product families, $650 million of assets and $600 million of liabilities (the $50 million difference is the equity plug). Every balance, coupon, margin and term is a round illustrative number. The mortgage, checking and savings positions carry the kernel's published default behavioral blocks (`MBS_DEFAULTS`, `NMD_DEFAULTS`, `BETA_S_CURVE_DEFAULTS`), copied into the file so it is self-contained; nothing in it is fitted to any bank's data.

| Family | Instrument | Positions |
|---|---|---|
| Cash and Placements | fixed-loan, bullet | one-month placement |
| Securities | fixed-loan, bullet | two-year and five-year notes |
| Fixed-Rate Term Loans | fixed-loan, level-pay | three-year and seven-year loans |
| Floating-Rate Loans | floating-loan | three-year floater on a one-month index, monthly reset |
| Residential Mortgages | mortgage | 30-year fixed pool, two years seasoned |
| Non-Interest Checking | nmd | decay on the default parameters, no paid rate |
| Money Market and Savings | nmd-b | default beta S-curve and decay buckets |
| Term Deposits | fixed-loan liability, bullet | one-year term deposit |
| Wholesale Term Funding | fixed-loan liability, bullet | three-year advance |

The file is a `PortfolioSpec` (`packages/engine/src/contracts/position.ts`): the chart of accounts travels with the positions. It uses the JSON import path the platform already has; there is no separate loader.

## The quickest way: load it on step 2

Explore the example bank on the first screen opens the larger example bank (`examples/mid-size-bank-v1.json`, about $5 billion, its analysis already run; `docs/oss/mid-size-bank.md`). This small book stays: start a new analysis, and on the Balance sheet step press "Or load the example positions (11 positions, dated 2026-03-31)". Each of the nine steps then says what it still needs.

## Load it in the Studio by hand

1. Start the platform: `npm run platform` (port 8787 unless `ALM_PLATFORM_PORT` says otherwise; the store is `var/store` unless `ALM_PLATFORM_STORE` names another).
2. Open the Studio, open or create a workspace that is not Production, and go to Balance Sheet, then Positions and import.
3. Choose `examples/example-book-v1.json`, enter your name in the By field, and press Import positions. The form stores the book and makes it the workspace's position book.
4. Run the workspace on the public market pack (`market_public.json`, Treasury CMT par yields with constructed vol surfaces).

## Load it over HTTP

```
curl -X POST -H "Content-Type: application/json" \
  --data-binary @examples/example-book-v1.json \
  http://127.0.0.1:8787/api/portfolios/import
```

The route answers 201 with the stored id (`example-book-v1`), or 422 with every validation error listed. Add `?workspaceId=<id>&by=<name>` to set it as a workspace's position book in the same call.

## Kept honest by a test

`apps/server/src/intake/__tests__/exampleBook.test.ts` imports the file on the JSON path with no error or warning, checks that its behavioral blocks equal the kernel defaults, and runs it over the regulatory rate grid on the public pack, pricing every family. If the position contract changes, that test fails before a learner finds out.

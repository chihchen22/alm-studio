# Gap: repricing, liquidity and the fixed-rate ladder

A gap ladder sorts the balance sheet by time. The repricing ladder asks when each dollar's rate can change; the liquidity ladder asks when each dollar comes back; the fixed-rate ladder asks when the rate-locked money is paid. This page covers the three ladders and the Quillfield figures behind Step 4.

## The idea and why a bank cares

Gap analysis is the oldest tool in ALM and still the one most people in a bank can read without a model. Lay assets and liabilities into time bands by the date they reprice, net them band by band, and the sign of each band says whether the bank earns more or less there when rates rise. Lay them by the date principal is repaid instead and the same table becomes a funding map: where the bank must find money, and where it has money to place. The ladders carry no discount rates and no behavior of their own beyond the cash flows they are given, which is their strength and their limit. They are read in minutes, and they say nothing about how much a dollar in a band is worth.

The fixed-rate ladder is the second half of a question the repricing ladder answers only in part. A fixed-rate amortizing loan reprices as its principal runs off, so the repricing ladder already places it by payment month; the fixed-rate ladder isolates that rate-locked principal from everything that floats, so you can see the fixed-rate book on its own, which is the book a hedge program is sized against.

## The method as Studio computes it

Every position's monthly cash flows are projected on the base path, and each dollar is placed in a bucket by month, then rolled up into bands: 0-1M, 1-3M, 3-6M, 6-12M, 1-2Y, 2-3Y, 3-5Y, 5-10Y and beyond 10 years. Each band's gap is assets less liabilities, and the cumulative gap is the running sum:

$$\mathrm{gap}_b = A_b - L_b, \qquad \mathrm{cum}_b = \sum_{j \le b} \mathrm{gap}_j.$$

In the repricing ladder a rate-locked position reprices as its principal runs off; a floater reprices its outstanding balance at its next actual reset (monthly in the first band, quarterly in the second, annual in 6-12M) and the principal that runs off before that reset at runoff; an interest-bearing deposit splits each principal dollar by its beta at the scenario's starting rate, the beta share in the first band and the rest at its decay runoff; a non-interest deposit is pure runoff; the swap's fixed leg reprices at maturity and its floating leg at its next reset, signed, in the assets column. In the liquidity ladder every position is placed by its principal repayment; undrawn lines, balances held at book and the swap are in neither ladder.

The fixed-rate ladder books the principal of each rate-locked position in the band of the month it is paid: fixed loans, mortgages, the certificate of deposit book, and any regulatory-convention core rung or non-interest non-core slice, each of which is held at a fixed paid rate. Floating loans and live deposits are left out. It is read on the base scenario only.

## Conventions and their choices

**Monthly buckets, a 360-month grid.** Bucket $k$ covers the $k$-th month from the as-of date, with no day weighting and no sub-monthly bucketing. A monthly setting adds one row per month beside the nine bands.

**The two ladders agree in total on the behavioral convention.** Every principal dollar is then in both ladders once, so the band totals of the repricing ladder sum to the band totals of the liquidity ladder and only the timing differs; the acceptance battery holds that identity on test books. Under the regulatory convention it does not hold, because the core rungs are held out of the repricing ladder (below) while their principal stays in the liquidity ladder.

**Beta, not beta drift.** The repricing split of an interest-bearing deposit uses the beta at the scenario's starting rate for the whole ladder, the base rate on the base scenario. The beta drifting along the path, which the earnings projection does model, is not in the ladder.

**Deposits under the regulatory convention.** The core rungs and the non-interest non-core slice are held out of the repricing ladder (the convention treats them as rate-insensitive at their paid rate), and they appear in the fixed-rate ladder as rate-locked principal. The interest-bearing non-core slice reprices in the first band as a one-month floater. The liquidity ladder places the rungs at their maturities whatever the convention.

**Principal only.** Both ladders carry principal. An interest-inclusive liquidity ladder is a switch on the run setup, which adds a second card beside the principal one; the stress ladder on [`liquidity.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/liquidity.md) is principal only as well.

## Quillfield worked example

In the repricing ladder at base, the first band nets to about <!-- num target=quillfield-v1 cell=gap.repricing.S0.bands[label=0-1M].gap scale=million dp=0 unit=$ sign=plus -->+$336 million: about <!-- num target=quillfield-v1 cell=gap.repricing.S0.bands[label=0-1M].assets scale=million dp=0 unit=$ -->$1,473 million of assets reprice within a month (the cash, the floating loans and the swap's floating leg, which the ladder signs into the assets column) against about <!-- num target=quillfield-v1 cell=gap.repricing.S0.bands[label=0-1M].liabilities scale=million dp=0 unit=$ -->$1,138 million of liabilities (the beta share of the interest-bearing deposits, the first month's deposit runoff, the floating advance and the first certificates of deposit to mature). The 6-12M band then swings the other way, a gap of about <!-- num target=quillfield-v1 cell=gap.repricing.S0.bands[label=6-12M].gap scale=million dp=0 unit=$ -->-$508 million as the bulk of the certificates of deposit mature, and the cumulative gap at one year is about <!-- num target=quillfield-v1 cell=gap.repricing.S0.bands[label=6-12M].cumulativeGap scale=million dp=0 unit=$ -->-$559 million: liability-sensitive within the year, so a rise in rates costs earnings, which is what [`nii-seg.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/nii-seg.md) found.

The liquidity ladder tells a funding story with the same shape. About <!-- num target=quillfield-v1 cell=gap.liquidity.S0.bands[label=0-1M].assets scale=million dp=0 unit=$ -->$424 million of assets return within a month (the cash and the first loan payments), and the cumulative liquidity gap at one year is about <!-- num target=quillfield-v1 cell=gap.liquidity.S0.bands[label=6-12M].cumulativeGap scale=million dp=0 unit=$ -->-$779 million: over the first year the deposits and the certificates of deposit are projected to return more principal to depositors than the loans return to the bank. The 2-3Y band then turns the cumulative gap positive, about <!-- num target=quillfield-v1 cell=gap.liquidity.S0.bands[label=2-3Y].gap scale=million dp=0 unit=$ sign=plus -->+$862 million in the band, as the $600 million three-year balloon on the fixed commercial real estate, the $350 million of three-year C&I lines and the $150 million of three-year agency notes all come back.

The fixed-rate ladder isolates the rate-locked money. About <!-- num target=demo-fixed-ladder-v1 cell=gap.fixedRate.rows[band=2-3Y].assets scale=million dp=0 unit=$ -->$1,050 million of rate-locked assets is paid in the 2-3Y band (the commercial real estate balloon and the three-year agency notes, with the amortizing loans' scheduled principal; the C&I lines float, so they are not here), and about <!-- num target=demo-fixed-ladder-v1 cell=gap.fixedRate.rows[band=6-12M].liabilities scale=million dp=0 unit=$ -->$452 million of rate-locked liabilities in the 6-12M band, the maturing certificates of deposit. Beyond five years the ladder holds assets only: the mortgages, the agency MBS and the long tail of the amortizing loans. Under the behavioral convention the deposits are live, so they are not in this ladder at all, and the 5-10Y band shows no liabilities. The ladder's cumulative gap closes at about <!-- num target=demo-fixed-ladder-v1 cell=gap.fixedRate.rows[band=10Y+].cumulativeGap scale=million dp=0 unit=$ -->$2,750 million, the net rate-locked principal of the book.

## Start here on this page

**Step 4, Fixed-rate repricing ladder (gap).** Open shows Gap and liquidity with the Fixed-rate gap card. On Run setups set the NMD convention to regulatory, press Save as a new version, launch it, and watch deposits fill the 5-10Y band: the deposit cores become fixed-rate rungs at today's paid rate, and the ladder's liabilities beyond five years go from nothing to a figure the card shows (it has no independent check, so it is not quoted here). Read the repricing ladder on the same run and the one-year cumulative gap closes to near zero, because the cores are held out of it.

The two deposit-desk demos whose Open lands on this screen, the straight-line runoff and component decay on a dated rate path, are described on [`deposits.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/deposits.md); their ladders and the Life by family card are where their forms show.

## What this page does not cover

The ladders by chart-of-accounts node and by tag view, the user-defined monthly buckets, the interest-inclusive liquidity ladder and the forecast gap (new volume in the ladders) are in Studio and not quoted here. The stress ladder and the survival path, which are liquidity gap analysis under a run on the bank, are on [`liquidity.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/liquidity.md).

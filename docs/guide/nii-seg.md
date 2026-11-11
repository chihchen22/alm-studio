# Earnings (NII) and the sensitivity equivalent gap (SEG)

Net interest income is what the bank earns on its assets less what it pays on its liabilities over a horizon. The sensitivity equivalent gap asks a sharper question: how much of the bank behaves like a fixed-rate balance when rates move a little. This page covers both, and the Quillfield figures behind Step 3.

## The idea and why a bank cares

Earnings are the number a bank reports every quarter, so a rate move that changes next year's net interest income by a few percent is felt at once, long before any change in economic value shows up. A bank whose assets reprice faster than its liabilities earns more when rates rise and less when they fall; one funded by deposits whose paid rates follow the market earns the opposite way. Most banks are a mix, and the mix shifts along the path as loans reset, mortgages prepay and deposits reprice. Earnings at risk is the plain reading of that mix: run the book under a shock and compare.

The sensitivity equivalent gap turns the same idea into a balance. A position that reprices at once contributes nothing to earnings sensitivity; a position locked at a fixed rate contributes its whole balance. SEG measures the rate-locked balance of the whole book by nudging rates a little and reading the earnings change, so a loan that is fixed for three years and a deposit whose paid rate follows a quarter of the market move each get the equivalent fixed balance their behavior implies. It is the gap a bank would need to hedge to make earnings insensitive, which is why it is read alongside the plain repricing ladder of [`gap.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/gap.md).

## The method as Studio computes it

Interest on each position in month $m$ is the start-of-month balance times its rate over twelve, a positive magnitude on either side. Net interest income over a horizon is the sum of asset interest less the sum of liability interest over the first $N$ months, with the swap's signed net settlement added last as the derivatives line:

$$\mathrm{NII}_N = \sum_{m=1}^{N} \left( \sum_{\text{assets}} B_{m-1}\,\frac{r_m}{12} - \sum_{\text{liabilities}} B_{m-1}\,\frac{r_m}{12} \right) + \text{derivatives}_N.$$

Under a shocked scenario the shocked curve applies from the first step, the same convention value uses, so a shocked earnings reading is a different rate environment evaluated from the start, not a shock that arrives during the year.

For SEG, Studio projects the existing book twice, under a small rise and a small fall (25 bp each way on the seeded demo), with every month's runoff replaced by a fresh vintage at the shocked rate so the balance holds. The cumulative repriced balance by month $t$ is the earnings difference between the two legs, annualized and divided by the two-sided shock:

$$\mathrm{cum}(t) = \frac{(I_{\text{up}} - I_{\text{down}})(t)\times 12}{2s}, \qquad \mathrm{SEG}_{\text{out}}(t) = N - \mathrm{cum}(t),$$

where $N$ is the signed notional and $s$ the shock. The outstanding SEG is the balance still locked at month $t$; the equivalent balance profile (EBP) beside it is the average of the up and down opening balances, assets and liabilities apart. A separate trio of runs at base and at plus and minus the NII shock (100 bp on the seeded demo) reads the 12-month earnings change on a constant balance.

## Conventions and their choices

**Run-off against going concern.** The demos read earnings on the run-off basis: the existing book pays down with nothing replacing it. The finished analysis of Step 1 holds every earning family at its opening balance through new volume, so its first-year earnings sit a little above the run-off figure. Both are management views of one book; the regulatory change in net interest income holds the balance sheet constant.

**What SEG covers.** The block covers every earning asset (the cash, the securities and the loans) and every liability except the certificates of deposit: the non-maturity deposits and the two advances. The certificates of deposit, the swap, the undrawn lines and the non-earning balances are listed as not covered, so the SEG block's earnings, its sensitivity and its margin are for that part of the bank. On Quillfield that leaves the $1,050 million of certificates of deposit outside the block.

**The SEG shock starts at step 1.** Step 0 reads the unshocked rate, so the first month's interest is the same on both legs. This differs from the scenario convention above, and it is why SEG is computed in its own block rather than read off the scenario grid.

**Margin bases differ.** The SEG block's margin is its 12-month earnings over total assets, the non-earning balances included. The peer margin in the data note is on average earning assets. The FTP book margin is a third figure, a weighted average of the families' transfer margins. The screens do not yet label which base each figure uses, so read a margin with its base in mind.

**The cohort-0 overlay.** On the seeded demo the mortgages already on the books prepay at a flat 6 percent a year under the rise and 20 percent under the fall, while each replacement vintage keeps the family's own prepayment model. That lets the demo show the mortgage option in the SEG profile without the existing pool's own S-curve.

## Quillfield worked example

On the run-off basis the bank earns about <!-- num target=quillfield-v1 cell=nii.S0.totalNet12 scale=million dp=1 unit=$ -->$173.1 million at base over the first year. A parallel rise of 200 bp lowers that to about <!-- num target=quillfield-v1 cell=nii.S200.totalNet12 scale=million dp=1 unit=$ -->$167.5 million, and a parallel fall of 200 bp to about <!-- num target=quillfield-v1 cell=nii.S-200.totalNet12 scale=million dp=1 unit=$ -->$165.1 million. Earnings fall both ways, for different reasons. Under the rise the interest-bearing deposits' paid rates rise by more than the floating loans and the pay-fixed swap gain; the fixed loan book does not move on a run-off, and the certificates of deposit lower their expense a little, since more of them are broken early. Under the fall the floating loans, the faster-prepaying mortgages and the swap lose more than the deposits' paid rates fall, and the deposits give back less under the fall than they cost under the rise, which is the beta S-curve's asymmetry. Of the six standardized shocks, the steepener helps most, about <!-- num target=demo-six-shocks-v1 cell=nii.byScenario[scenarioId=SRP-STEEP].totalNet12 scale=million dp=1 unit=$ -->$176.8 million, and the flattener hurts most, about <!-- num target=demo-six-shocks-v1 cell=nii.byScenario[scenarioId=SRP-FLAT].totalNet12 scale=million dp=1 unit=$ -->$163.1 million.

The SEG block starts at the book's net notional, about <!-- num target=demo-seg-v1 cell=seg.book.segOutstanding[0] scale=million dp=0 unit=$ -->$1,350 million of equivalent fixed balance: about <!-- num target=demo-seg-v1 cell=seg.book.ebpAssets[0] scale=million dp=0 unit=$ -->$4,750 million of covered assets less about <!-- num target=demo-seg-v1 cell=seg.book.ebpLiabilities[0] scale=million dp=0 unit=$ -->$3,400 million of covered liabilities, the non-maturity deposits and the two advances. The floaters and the beta share of the deposits reprice at once, so the profile moves in the first months and peaks at about <!-- num target=demo-seg-v1 cell=seg.book.segPeak.value scale=million dp=0 unit=$ -->$1,675 million in month <!-- num target=demo-seg-v1 cell=seg.book.segPeak.month scale=one dp=0 -->5; by month 12 it is about <!-- num target=demo-seg-v1 cell=seg.book.segOutstanding[12] scale=million dp=0 unit=$ -->$1,601 million. The fixed loans then run off and the long-lived deposit cores remain, so the profile crosses zero and turns negative in the later years, which says the deposits, not the loans, are the longer side of this bank.

The earnings trio reads about <!-- num target=demo-seg-v1 cell=seg.book.nii.base12 scale=million dp=1 unit=$ -->$219.4 million of covered earnings at base on a constant balance. A 100 bp rise lowers it by about <!-- num target=demo-seg-v1 cell=seg.book.nii.base12 minus=seg.book.nii.up12 scale=million dp=1 unit=$ -->$2.2 million, and a 100 bp fall leaves it almost where it was, about <!-- num target=demo-seg-v1 cell=seg.book.nii.down12 scale=million dp=1 unit=$ -->$219.5 million. The block's margin is about <!-- num target=demo-seg-v1 cell=seg.nimPct scale=one dp=2 -->4.39 percent of total assets, above the data note's peer margin of 3.84 percent on earning assets, because the certificates of deposit, the bank's costliest funding, are outside the block and the earnings are read on a constant balance; the base, total assets, pulls the other way and does not close the gap.

## Start here on this page

**Step 3, Earnings sensitivity (SEG).** Open shows the SEG / EBP screen. On Run setups set the NII shock to 200 bp, press Save as a new version, launch it, and watch the earnings change grow: with twice the shock the first-year change under the rise roughly doubles. The screen shows the figure; it has no independent check at 200 bp, so it is not quoted here.

## What this page does not cover

Earnings with new volume (the finished analysis), the monthly earnings card, the earnings attribution and the stochastic earnings fan are in Studio and not in the replica, so they are not quoted. FTP, which decomposes the same net interest income into lending margin, funding margin and mismatch, is on [`ftp.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/ftp.md). The plain repricing ladder is on [`gap.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/gap.md).

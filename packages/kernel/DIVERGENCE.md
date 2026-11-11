# @alm/kernel: Divergence from the kernel source

**Kernel files whose bytes differ from the kernel source: 71.** 68 TypeScript files whose changes are comments, a listed string literal or an import path (4 of them in the renamed folder); 3 test fixtures whose note strings lost a path or a name outside this repository (no test reads the notes). The kernel `package.json` also differs (below).

The export step makes these kinds of change:

1. Comment wording. Comments that cited documents, paths, people or build history outside this repository are reworded or removed. Every remaining kernel comment line that a broad net of history words hits is on a reviewed list with its reason.
2. String literals. Eight string literals (test titles and two description strings) lose wording that pointed outside this repository. The token check applies the same list to the source before it compares.
3. One folder, `src/math/behavioral/defaults/`, has another name in the source, and every import that names it follows. The files in it are public curves, judgment constants and illustrative pins, not values fitted to data.
4. Test fixture notes. Paths and names outside this repository are stripped from three fixtures' note strings.
5. Two files are left out: a measurement gate the shipped tests do not use, and one structure test of the client-rate model; nothing here imports either.
6. Data notes. The two public data files, `public/market_public.json` and `public/rate_history_public.json`, lose paths and decision notes outside this repository from their note strings; their numbers are unchanged, and `PROVENANCE.md` hashes the bytes here.

The export's gates compare every kernel TypeScript file here with the kernel source token by token, comments excluded and the listed changes applied: the code is the source's.

Files whose bytes differ from the kernel source:

- `src/index.ts`
- `src/math/analytics/__tests__/duration.test.ts`
- `src/math/analytics/__tests__/nmdStockCalibration.test.ts`
- `src/math/analytics/__tests__/tractor.test.ts`
- `src/math/analytics/duration.ts`
- `src/math/analytics/ftpLoans.ts`
- `src/math/analytics/ftpStochastic.ts`
- `src/math/analytics/nmdFrontier.ts`
- `src/math/analytics/nmdStock.ts`
- `src/math/analytics/seg.ts`
- `src/math/analytics/tractor.ts`
- `src/math/analytics/types.ts`
- `src/math/behavioral/__tests__/fixtures/sfrIllustrativeReadoutV2.det.json`
- `src/math/behavioral/__tests__/nmdRegime.test.ts`
- `src/math/behavioral/__tests__/sfrIllustrative.test.ts`
- `src/math/behavioral/cdBook.ts`
- `src/math/behavioral/championFan.ts`
- `src/math/behavioral/clientRateModel.ts`
- `src/math/behavioral/ddaChampion.ts`
- `src/math/behavioral/ddaChampionPaths.ts`
- `src/math/behavioral/defaults/labCurvePublic.ts`
- `src/math/behavioral/defaults/mmaEveCurvePublic.ts`
- `src/math/behavioral/defaults/prudentialShape.ts`
- `src/math/behavioral/defaults/sfrIllustrativePins.ts`
- `src/math/behavioral/depositBook.ts`
- `src/math/behavioral/illustrative/__tests__/cdIllustrative.test.ts`
- `src/math/behavioral/illustrative/cdIllustrative.ts`
- `src/math/behavioral/illustrative/ddaIllustrative.ts`
- `src/math/behavioral/illustrative/mmaIllustrative.ts`
- `src/math/behavioral/illustrative/repricingIllustrative.ts`
- `src/math/behavioral/mbsModel.ts`
- `src/math/behavioral/mmaGranularPaths.ts`
- `src/math/behavioral/mmaSwitchingSpread.ts`
- `src/math/behavioral/mmaTwoSleeve.ts`
- `src/math/behavioral/nmdModel.ts`
- `src/math/behavioral/prepay.ts`
- `src/math/behavioral/prudentialSurface.ts`
- `src/math/behavioral/repricingSurface.ts`
- `src/math/behavioral/repricingSurfaceTypes.ts`
- `src/math/behavioral/sfrIllustrative.ts`
- `src/math/instruments/__tests__/nmd.test.ts`
- `src/math/instruments/__tests__/nmdBeta.test.ts`
- `src/math/instruments/mortgage.ts`
- `src/math/instruments/nmd.ts`
- `src/math/instruments/nmdBeta.ts`
- `src/math/instruments/types.ts`
- `src/math/optim/levenbergMarquardt.ts`
- `src/math/rates/__tests__/bootstrap.test.ts`
- `src/math/rates/__tests__/cmtProjectionParity.test.ts`
- `src/math/rates/__tests__/fitError.test.ts`
- `src/math/rates/__tests__/fixtures/cmtProjectionParity.json`
- `src/math/rates/__tests__/fixtures/market_constructed.json`
- `src/math/rates/__tests__/hwPricing.test.ts`
- `src/math/rates/__tests__/legacyTlpFixture.ts`
- `src/math/rates/__tests__/sabr.test.ts`
- `src/math/rates/__tests__/shippedAlignment.test.ts`
- `src/math/rates/__tests__/simulators.test.ts`
- `src/math/rates/bgmCalibrate.ts`
- `src/math/rates/bgmPricing.ts`
- `src/math/rates/bootstrap.ts`
- `src/math/rates/calibrationThresholds.ts`
- `src/math/rates/hwCalibrate.ts`
- `src/math/rates/hwPricing.ts`
- `src/math/rates/importWorkbook.ts`
- `src/math/rates/marketData.ts`
- `src/math/rates/random.ts`
- `src/math/rates/rateHistory.ts`
- `src/math/rates/sabr.ts`
- `src/math/rates/sabrHeuristic.ts`
- `src/math/rates/simulateBgm.ts`
- `src/math/rates/simulateHw.ts`

The kernel `package.json` also differs: it takes `xlsx` 0.20.3 from cdn.sheetjs.com (see `PROVENANCE.md`).

## Engine mirrors of kernel code

One engine file restates a kernel function body instead of calling it, because the kernel offers no seam for the change the engine makes. A mirror is not a kernel divergence (the kernel bytes stay pinned), and the hash rows in `PROVENANCE.md` do not cover it: a re-vendor that changes the mirrored body would leave the mirror on the old operation order with no hash to say so. Each mirror therefore names a parity guard, and the re-vendor checklist runs every guard listed here after `verify` and before the new pin is recorded.

This note lives here and not in `PROVENANCE.md` because the engine stamps a SHA-256 of the `PROVENANCE.md` bytes into every run's provenance (`provenanceFileHash`, `packages/engine/src/provenance/kernelRef.ts`), so a prose edit there would move every golden and stored-run hash. Nothing hashes this file.

- `packages/engine/src/macro/housingMortgage.ts` mirrors `Mortgage.generateCashflows` in `src/math/instruments/mortgage.ts`: the benchmark tenor 10 as a literal, the `(secSpread + primSpread) / 1e4` spread, the `wac: noteRate * 100` override of the prepayment parameters, the kernel `FourFactorCPR` schedule and `amortizeMortgage`, in the kernel's order. The house-price response is applied between the schedule and the amortization. Guard: A2 parity, `packages/engine/src/macro/__tests__/housingMortgage.test.ts` (instrument level, every seeded mortgage term set on a flat path, byte for byte against the kernel `Mortgage`) and `packages/engine/src/run/__tests__/housingFlatIdentity.test.ts` (run level, every result block byte-identical on the flat projection, with the wrapper count tied to the mortgage factory-call count). A failure on a re-vendor means the kernel body moved: update the mirror to the new body and re-run both, never re-pin the parity.

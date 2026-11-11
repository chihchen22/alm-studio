# @alm/kernel: Provenance

This package is the ALM math kernel. Its files are a copy of the author's kernel source at the version below, with the changes `DIVERGENCE.md` lists: comment wording, a few string literals, one folder name with the import paths that name it, three test fixtures' and two data files' note strings, two files left out, and the `xlsx` pin. The export's token check holds that no other code token changed, so every computed number is the source's.

- **Kernel source id:** `bc5f5c84f37093846cb2c2caa89cfdb2d0c87895` (the first 40 hex digits of the SHA-256 of the math-file hash rows below; every run stamps it as `provenance.kernel.sourceCommit`)
- **Copy date:** 2026-09-24
- **Hash rows:** over the bytes of this copy.

## What is here

Every non-test `.ts` file of the kernel source's `src/math` is here, with the tests that run on the files this repository ships. 58 source files are not (tests and data modules that need inputs this repository does not ship), and two more (a measurement module that only those tests use, and one structure test of the client-rate model).

## Tests

The kernel suite here is 34 test files (`npm test --workspace @alm/kernel`).

## Runtime dependencies

| Dependency | Version | Imported by |
|---|---|---|
| `ml-levenberg-marquardt` | ^4.1.3 | `rates/hwCalibrate.ts` |
| `xlsx` | 0.20.3, from the SheetJS download site (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`) | `rates/importWorkbook.ts` |

The kernel source pins `xlsx` 0.18.5; this copy takes 0.20.3 from cdn.sheetjs.com, the release the server already uses, because the registry's 0.18.5 carries public advisories.

## Supporting data fixtures

| Fixture | SHA-256 |
|---|---|
| public/market_public.json | f7c7f242ffaab04e43527cce577de71f8f43e9dc4a521416eb65386f0c67f774 |
| public/rate_history_public.json | ee17d8078bccda064a2612d1e0527da3a980c64f0a2ad1c9f7f5b31a48987f07 |

## Kernel math files (SHA-256)

98 files, hashed over the public bytes (lowercase SHA-256 of the raw bytes, no line-ending normalization). `packages/engine/src/provenance/__tests__/kernelIntegrity.test.ts` and `npm run accept` re-hash every row.

| File | SHA-256 |
|---|---|
| src/math/analytics/__tests__/analytics.test.ts | c350a0bc47c4ab6bb5f114b7347d160110dc964eb1c02cd63c3bf3e27296feb1 |
| src/math/analytics/__tests__/duration.test.ts | f6bfe1d6dd84b9ccfb712675ad625751628ad3e44a10c275d4242069c45af155 |
| src/math/analytics/__tests__/ftpLoans.test.ts | 6266ce925b4aaae25f07bde5f327005770e94b698edfa2bb59ef3fd7df72339e |
| src/math/analytics/__tests__/ftpNmd.test.ts | 41d69a3cb01afc8e0edac149dfb804a2d7a5ed3016cd26ebd5871386aee91044 |
| src/math/analytics/__tests__/ftpStochastic.test.ts | 8baa4646a4000f1991e3a0123f4f1a0bb196f53387d37752c369d02f621a8349 |
| src/math/analytics/__tests__/nmdStock.test.ts | 891a241eedcdad197d6e005adbebca14e5a6d43ad13ff82eb87d9a5e9a61ae11 |
| src/math/analytics/__tests__/nmdStockCalibration.test.ts | 2a3aa64a2311d47bf99a979c0a8f207a08d79afc6211152f763dc0d765ced4b3 |
| src/math/analytics/__tests__/seg.test.ts | 853127315d2e94049768f1ec4c298c2a1a7466d891dcbd30885e0b02fd08ac8f |
| src/math/analytics/__tests__/tractor.test.ts | e7f0543091467199add509f69dd4393323aaebac758c7ab592714877c24e509e |
| src/math/analytics/__tests__/tractorBgm.test.ts | 9002a9d7e18440489a8948f88ea1eb4fbc8c7d4229095cb19f0c2549a0d894c8 |
| src/math/analytics/duration.ts | 762e9667c84ebcde589bf0e23fee52b41deb0ce799e3429bf0991dbef9f59496 |
| src/math/analytics/ftp.ts | 009e31f27f1f4514861eb4a20a6cb08c12089f07a9ab20fab30b5667926e6f59 |
| src/math/analytics/ftpLoans.ts | af33693999cdbe8787c09652661a19356478066a5307cf37abd7d0f4890b2317 |
| src/math/analytics/ftpNmd.ts | c889af0e21e69c0dfe41f5f125c92f0096f668cd54090603040fd7315619a9bc |
| src/math/analytics/ftpStochastic.ts | 7f55827b833567ce1a03185f591070f0d8887df2047a5de47dfb2c83c76a7d40 |
| src/math/analytics/nmdFrontier.ts | 34c99471e3a09f8bea67daddee5aa58e4ce59caf2d13cf167cabb31f759cc7b7 |
| src/math/analytics/nmdStock.ts | ab6a14da63344180ad32f04be709908569cde56cd7aee5fdc6ad25b33c6b4daa |
| src/math/analytics/seg.ts | a1dafde9aa2f7d36fa6085ab16048faa45080b620f405133e2436820862832f6 |
| src/math/analytics/tractor.ts | 5fe84dd245968f0f6d69da1cd758629b573508a7a6ecbd7fec41d50d23713234 |
| src/math/analytics/types.ts | a31eb7f570830a871cb50385a3f1992179b4a9d96ae72f34c10cc272f4775476 |
| src/math/behavioral/__tests__/championFan.test.ts | 65a4d7b2be3b850e8dce2fcba2dcd3105bc2e44b8cd97e0c704995c2d1085b6c |
| src/math/behavioral/__tests__/fixtures/sfrIllustrativeReadoutV2.det.json | 53b79662bfd00ce7e0a41021f8d517b03c725b145ddbd192b92509a4f6d81dfa |
| src/math/behavioral/__tests__/mbsConstantCpr.test.ts | 66c261cfaa3892118195f3f59aec358bda307b3f6c12d7e6b34afe1296ff223b |
| src/math/behavioral/__tests__/nmdRegime.test.ts | d98e162e5a66ac82c25b207d378a00c7450c607e78713a89fadf36b98eb0136a |
| src/math/behavioral/__tests__/nmdSurface.test.ts | 031e541f5255deed46272697e5a64d7796379fba1e123cf049096192639f1c40 |
| src/math/behavioral/__tests__/sfrIllustrative.test.ts | 64d9b45c7e4a6964095aa9fb769d714449cf3be2314f2e8f2f8f937338a1a801 |
| src/math/behavioral/cdBook.ts | 0e4f683c751e7d4fd3e3d06670e423ad6a56e687062d89931d8b518220dfe435 |
| src/math/behavioral/championFan.ts | 58fa318f6c51eba4436b77185b46d76dfa32d31b02ccd34f233dfab2cfffd0c2 |
| src/math/behavioral/clientRateModel.ts | e97443754d6eb796ba0de4ee13a0dd685a09c0b80007c8a77cbec9a6d7c850f6 |
| src/math/behavioral/ddaChampion.ts | 140692df0f967cc1c6ad5bcb6e7d3a691003409e4ea1fad27b4fd52f901fa1b3 |
| src/math/behavioral/ddaChampionPaths.ts | 7979e072c35a7b33eafc2232930f58203fd730fc0e6a1ca5ad77f94fbecb210e |
| src/math/behavioral/defaults/labCurvePublic.ts | 67765b8cd887641a382f1203fc13bc109eb9196f96352e29782b781877b8679f |
| src/math/behavioral/defaults/mmaEveCurvePublic.ts | 9da7eec4fae2fff7144022a95fa67c7812fde5fbfc6bd2ebd7321ad234b1898f |
| src/math/behavioral/defaults/prudentialShape.ts | 23fc80846a3c085b0a02cb4178261a70d5bcd8a8c0ba5451a0ec97188a802b11 |
| src/math/behavioral/defaults/sfrIllustrativePins.ts | 3119288dcd7fcb859f0d45ea7eaac91c4f28f35e9c70559cd22976e10c2fbf26 |
| src/math/behavioral/depositBook.ts | 5389f9180792a1b7daf76f8c5be6f93d8596d20fcf8967c50387ca980706fa90 |
| src/math/behavioral/fanStats.ts | a0bc75f041f4e08fdbf359fe5776de2a134aa4a1bc4b54e4d2064129999f36d9 |
| src/math/behavioral/illustrative/__tests__/cdIllustrative.test.ts | b65586f03a9c1b16e883210af8a7cfc2edb9ce720dda4d68db6a733dcb841156 |
| src/math/behavioral/illustrative/__tests__/ddaIllustrative.test.ts | 279cdc7dcfd25ba77be570f49cbd7a53979c5f4352ade2a6f41816a1cebef5d5 |
| src/math/behavioral/illustrative/__tests__/mmaIllustrative.test.ts | f63fb4c383fde594d6935be4c2a1de65ad50e73a2aa8de2b76fe59f7b3ea5a7e |
| src/math/behavioral/illustrative/__tests__/repricingIllustrative.test.ts | 3b15eb9285d0765e3240776d00af904759722ba73d3649052bc7bfda0a50ca23 |
| src/math/behavioral/illustrative/cdIllustrative.ts | 81de8915384d7b281c0f4fe59b4951724fb2b764902a9076d7d26432f2829d5d |
| src/math/behavioral/illustrative/ddaIllustrative.ts | a935ea4e94dc262e961523ee108989e3a80923d5d87f060b4dc067d7146cd106 |
| src/math/behavioral/illustrative/mmaIllustrative.ts | 37e39d2a1d5e46b577aedaa1ba3f737ba550ad2945e5f0e8fb90a79cf3f82d5d |
| src/math/behavioral/illustrative/repricingIllustrative.ts | f6463fb9d808167bc6f55a7c9a3c48353610d47c1ccec1fea61c163902a14a35 |
| src/math/behavioral/mbsModel.ts | 821264da9251456770ef27daec58ce3a0ddd09e50f40dee1add0f3ade2a4c160 |
| src/math/behavioral/mmaGranularPaths.ts | afdeb45ceb1f4e399d90547c9aae3d6bb32971fb3f890990ff9522d896902798 |
| src/math/behavioral/mmaSwitchingSpread.ts | 1a7dff9f635e5b69333d10e52ffeb441c7c72d9c7c811037a2edc27abca8f9fe |
| src/math/behavioral/mmaTwoSleeve.ts | 970aa60068254ae38815ccec0d903bff822ea63fcbacb719ca9999190225b1fa |
| src/math/behavioral/nmdModel.ts | e9eeebaf8447e570588929ef65f1489136a952bdf9e88665d3d01d730a23da78 |
| src/math/behavioral/prepay.ts | 65d02a449ff094c83080910006dc3b6be097013f2b93a2d40c685f64edfd0662 |
| src/math/behavioral/prudentialSurface.ts | 6bce5c52a951bbd31a7c9b6d0a4e63cc6b5f2e61279ed1ac5313ccb3faf6dc5f |
| src/math/behavioral/repricingSurface.ts | e1ea6926f3d4075cff1137f5e20b081f06839a9df1340caef76fd5c2671b10e2 |
| src/math/behavioral/repricingSurfaceTypes.ts | ed9b832406c7ae78c23bf6b7db8e45cfff159b800e9e8ecfb55d4ad7989ad221 |
| src/math/behavioral/sfrIllustrative.ts | 5d570fd85f61811ab8d0312afef70618810d5af35288adcf021092c0b958c0c9 |
| src/math/instruments/__tests__/loans.test.ts | 5c8833ab1e40b44ae42c5ef10f424e1dfdad340933f0f580bd4ee807011fc846 |
| src/math/instruments/__tests__/mortgage.test.ts | fe630b1df65e368440e6f8a94ed840a5c6599ebf8d551afea41b08978fca753a |
| src/math/instruments/__tests__/nmd.test.ts | 4d1a24f3a293c144012a37f35c9f816c31d3099b943abcb8c8ac862e1e192985 |
| src/math/instruments/__tests__/nmdBeta.test.ts | b2d8b1ab30579f776bf12b56688c0d1c8c1cc32c78f97ea26e02fd1a48aec691 |
| src/math/instruments/fixedLoan.ts | 1998d847af443bd8f050e915bd9a8ab83e6c6d7f4c4e61dc44c5967df6f2fc41 |
| src/math/instruments/floatingLoan.ts | 41c29651cc002ee8d5e8d138f875e938624236905e6447d601783fedda10bb97 |
| src/math/instruments/mortgage.ts | bfc34252b1acdc3595fa76a33fb8ed4db0f31d47572012f9b305f6606e9d23e3 |
| src/math/instruments/nmd.ts | 91f2bc430417df8ddf1d2c2ec7c2330d71260edb4d1b4ff178291bc575df5c75 |
| src/math/instruments/nmdBeta.ts | 57169f8696cec01714b252666352bc4b8dd8417e7d49a06c4f4ae84cab5bf823 |
| src/math/instruments/types.ts | 9849fda1eb7ba3b97879a2395de648a99533ee00736fc252f4eb9fb8c7794fc9 |
| src/math/optim/levenbergMarquardt.ts | 040331cc96210753c66412b9a10ce487444d7546b9dd34238c09cfacaebfb04a |
| src/math/rates/__tests__/bgmPathTools.test.ts | f28d3140c9e884408c215c0144e5d911fff629bad4e9a09f396394ec546a65c1 |
| src/math/rates/__tests__/bootstrap.test.ts | 9951f1d7ebb933f2e33d64e09fdc706bba4c4057cf644510bc63a748feed127f |
| src/math/rates/__tests__/cmtProjectionParity.test.ts | 1f9006c98b1b755f48d7dca78608950ff3e6baa9b8364eddf6eba95a30da91f6 |
| src/math/rates/__tests__/fitError.test.ts | 1b265bf23f60b39cf336226a5c853829839db2c9869bb25b613183685119b7fb |
| src/math/rates/__tests__/fixtures/cmtProjectionParity.json | edcbc26b9f4b80222233b9a97361bbfa0996bb3ab58abd9f85403fa596923c4e |
| src/math/rates/__tests__/fixtures/market_constructed.json | eed39902efaef0b0f832a7b3a0a9a079bae06224d16e03e8eb514526df3863b5 |
| src/math/rates/__tests__/hwPricing.test.ts | 3132c5177d73f2b34651531f3d01e3f6910cc7af9087a3fc2411a6e18a5473d8 |
| src/math/rates/__tests__/legacyTlpFixture.ts | 13ff68044fb7254ae8e4b13c3c667122ca29edd131e1dd1d74d9816693ae8b7e |
| src/math/rates/__tests__/ratePath.test.ts | 5650af6b9b88d2eed5b09e0451e572ad8bc915bcdc844a1babe2bc5eb9f2e8a1 |
| src/math/rates/__tests__/ratePathAccrual.test.ts | bb628d4250f6ac95a7f85144756962b7fff9d3e2e2ce68f1229fafdef60f4bd3 |
| src/math/rates/__tests__/sabr.test.ts | ee0061e8c7fd97fcc9ce7444d0d0c6a0592d91b41236eb8e877e0f87ed43bd65 |
| src/math/rates/__tests__/shippedAlignment.test.ts | a4a261f4621dd92fa81d1e0bbc63e91a80f4deaaf272ac29bed5e3bda3f48748 |
| src/math/rates/__tests__/simulators.test.ts | cb3a62694bfefd4306dab50c6bab67f656efe24fb0a3288e55ef42335f928ee9 |
| src/math/rates/__tests__/tenorProjection3m.test.ts | 33be29559099754d22b5f90370a7091e96a25a07e6fc3e93973e424ecfb57373 |
| src/math/rates/bgmCalibrate.ts | 39ef8a6892e40fa56e7cb8078e187d3a574445174b88b4c150b32f926b9c966b |
| src/math/rates/bgmPricing.ts | 114637ac21aa993f81488076ea0c1f775fff2a90f9e63ae72818d4a91fa67da6 |
| src/math/rates/bootstrap.ts | 5f127bd04e0f02cf6b2882e96f1c3849b32a20245c898844c5e6f8c4d3f7b65c |
| src/math/rates/calibrationThresholds.ts | 18f33ec1aea2a3a7fe5f55363bf95ccf36545f37dc7a9332fb707e2c9d89387c |
| src/math/rates/fitError.ts | 84dc9abdc4e9cef0d608b571c0c4902ea0ae78092cfed7b84eae3138225dc0b4 |
| src/math/rates/hwCalibrate.ts | 1883ed0005fd832dc0fb40fc453babc0adbeb95b402a4c305c59d0ad1b69638b |
| src/math/rates/hwPricing.ts | 8ca5f7caf48204934658a45fd47d83b3b56b36e89abd6e9c98b547d4c3e3154e |
| src/math/rates/importWorkbook.ts | 3cb09534fd37225003a206c2c6e365c2bd06c4e14ce7f5107a563c0d2c0fa614 |
| src/math/rates/marketData.ts | 2a70c860cbb85b2a7cf3e00c5da39a267963342393907198d9098c88d42ee788 |
| src/math/rates/random.ts | 5bff71be351b1d8a5b81d0a93fc86dc467bc3978c3d9340dd8678ecd09a29153 |
| src/math/rates/rateHistory.ts | 9615cae1a6ee187f6357f34efa90e908129e87d6f04060bb7b84ac3e542207d6 |
| src/math/rates/ratePath.ts | cc5fa483a652da14d2adf6771e4658f70d1aeae43714a8b310df071e2597520d |
| src/math/rates/rootFind.ts | f8f4b44dd7d083d2acf27e08025361cd7c111a2e52c352996cd69678777f68a9 |
| src/math/rates/sabr.ts | 21bdf635dbbb7b24dbda1fe8c0aef2e01305d738fd531640505e57caa80b3ff4 |
| src/math/rates/sabrHeuristic.ts | 61d9b8d0115928fc07ac07ac7f656bebe0a14939858dfacaa7f214693bb707dd |
| src/math/rates/simulateBgm.ts | b1ae59d11aa2c1631dd29ae259444b7f81726373e030048cb6dc20dde34819c2 |
| src/math/rates/simulateHw.ts | 02863a9545eaa707eb38a5c8198fad4816a0d7f4b4b31f0a674c02cfb897a6dd |
| src/math/rates/tlpCurve.ts | fbb62bb4fd721d8b20117d1523f5158adf46cb7d59089fe6c8a92450aad5f8d0 |

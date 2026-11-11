/**
 * @alm/engine NII module.
 *
 * Side-signed net interest income at 12 and 24 months from the projected
 * bucketed cash flows, decomposed to product family with scenario totals. Asset
 * interest is income, liability interest is expense (the alm-nii sign
 * convention); the kernel emits interest as a positive magnitude on both sides
 * and the flip lives in this module.
 */
export { computeNII, NII_HORIZONS_MONTHS, niiNimPct, totalAssetNotional } from "./computeNII";
export {
  DEFAULT_NII_WINDOW_MONTHS,
  isEngineReportHorizons,
  reportHorizonsConfigError,
  windowMonthsConfigError,
} from "./reportHorizons";

/**
 * @alm/engine FTP module.
 *
 * Deterministic three-leg par-matched FTP (IR vs SOFR, all-in vs SOFR + TLP,
 * LP residual) wrapped from kernel ftp.ts, aggregated to the COA family grain,
 * with the book NIM bridge welded to computeNII. Base scenario only;
 * shocked series refuse with the typed `ftp.shocked-scenarios` tag.
 */
export {
  computeFtpResult,
  FTP_ACCRUAL_DT_YEARS,
  FTP_BRIDGE_HORIZON_MONTHS,
  FTP_SHOCKED_SERIES_LAYER,
  FTP_ZERO_NOTIONAL_GUARD,
  type FtpComputeInput,
} from "./computeFtp";
// The replicating-portfolio credit of a deposit and its run checks.
export {
  OVERNIGHT_MONTHS,
  ReplicatingPortfolioCredit,
  RpPricer,
  bulletCashflows,
  lifeTargetBlend,
  runoffCashflows,
  steepenedSnapshot,
  type RpDeposit,
  // The credit on the balance path or a capped life, read at every scenario.
  depositFacts,
  scenarioCredit,
  scenarioCreditReadout,
  type RpRunScenario,
  type RpScenarioFacts,
} from "./replicatingPortfolio";
export {
  checkReplicatingPortfolioRun,
  replicatingPortfolioRefusal,
  setsBindReplicatingPortfolio,
} from "./replicatingPortfolioRun";

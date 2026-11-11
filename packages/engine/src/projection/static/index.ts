/**
 * @alm/engine static runoff projection module.
 *
 * Static balance-sheet runoff: the existing book runs off under a scenario's
 * shocked rate path and behavioral overlays, with no new business. Drives EVE
 * and both gap ladders. The cash-flow core is the m03 aggregator; this module
 * adds the static-mode guard, overlay application, and shocked-path wiring.
 */
export {
  buildScenarioRatePath,
  projectStaticScenario,
  projectStaticRunoffAll,
  findNegativeBalance,
  type StaticScenarioLeg,
  type NegativeBalanceHit,
} from "./staticRunoff";
export { applyStaticOverlays, checkBindingOverlap, StaticOverlayError } from "./applyOverlays";

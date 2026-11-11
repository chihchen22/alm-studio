// The curve setup builder. The run reaches it through buildBaseCurve (scenario/rateEnvironment.ts) for a market carrying a curveSetup block and, since step B4 Task 5, for an unmarked market with none: defaultSetupFromSnapshot fills the setup that market builds on (curve default version 2).
export { validateCurveSetup, MAX_CURVE_INPUTS, MAX_TENOR_MONTHS } from "./validate";
export { makeZeroInterpolator } from "./interpolators";
export { solveNodes, CurveBuildError } from "./solve";
export { buildCurveFromSetup, type BuiltCurve } from "./buildCurve";
export { registerQuoteTenors, quoteTenorsOf, inheritQuoteTenors } from "./quoteTenors";
export { defaultSetupFromSnapshot, type DefaultSetupResult } from "./fromSnapshot";

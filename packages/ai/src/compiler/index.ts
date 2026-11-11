/**
 * Natural-language to assumption-set compiler (m13).
 *
 * The LLM authors a candidate AssumptionSet in the MCP client; this module owns
 * the deterministic remainder — validate through bindAssumptions, diff against
 * the base, and write the show-before-run rationale. It never computes a
 * balance-sheet number.
 */
export { createAssumptionCompiler, type CandidateAuthor } from "./compiler";
export { diffAssumptions } from "./diff";
export { buildRationale } from "./rationale";

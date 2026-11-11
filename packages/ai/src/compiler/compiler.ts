/**
 * The AssumptionCompiler implementation.
 *
 * Division of labor: the natural-language authoring of the
 * candidate AssumptionSet is the LLM's job and happens in the MCP client. This
 * module owns only the deterministic remainder: accept the candidate as data,
 * validate it, diff it against the base, and write the show-before-run
 * rationale. Nothing here computes a balance-sheet number.
 *
 * Validation is three gates, all of which must pass before the candidate is
 * hashed or diffed, so the show-before-run surface never displays a candidate
 * that would die at run time. First, every binding's target family is
 * cross-checked against the run's family catalogue with the same exact-string
 * membership test resolveAssumptions applies (an unknown or wrong-case family
 * throws UnknownFamilyError, naming the bad family and the known catalogue).
 * Second, every binding's overlay kind is checked against the target family's
 * instrument type through checkOverlayCompatibility — the SAME function, over
 * the SAME table, that resolveAssumptions calls at run time, so the compile
 * gate and the run gate cannot drift (a deposit-beta bound to a fixed-loan
 * family throws IncompatibleOverlayError here, on the show-before-run surface).
 * Third, bindAssumptions runs the structural check and fills the contentHash
 * (a malformed set throws AssumptionValidationError). bindAssumptions alone
 * does not check family membership or compatibility; these cross-checks are
 * what stop a hallucinated or misbound family from reaching the diff.
 *
 * The authoring step is injected as a `CandidateAuthor` so the whole surface is
 * testable without a live model: tests pass a fixed instruction -> candidate
 * map; production passes the Claude-backed author. The frozen
 * `AssumptionCompiler.compile(input)` signature is preserved on the returned
 * object.
 */
import { bindAssumptions, UnknownFamilyError } from "@alm/engine/src/scenario";
// Deep import: the compat gate ships this wave from resolveAssumptions itself;
// the scenario barrel line is a wave-boundary step (module report W1-H2).
import { checkOverlayCompatibility, overlayModelOf } from "@alm/engine/src/scenario/resolveAssumptions";
import type {
  AssumptionCompiler,
  AssumptionSet,
  CompileAssumptionsInput,
  CompiledAssumptionSet,
} from "@alm/engine";
import { diffAssumptions } from "./diff";
import { buildRationale } from "./rationale";

/**
 * The LLM authoring seam: maps an instruction (plus base and family catalogue)
 * to a candidate AssumptionSet. Implementations must mutate only the families
 * the instruction targets and must never fabricate a number the instruction did
 * not ask for. The candidate is treated as untrusted data downstream: it is
 * validated before anything else uses it.
 */
export type CandidateAuthor = (input: CompileAssumptionsInput) => AssumptionSet;

/**
 * Build an AssumptionCompiler around an authoring seam. The returned object's
 * `compile` runs the deterministic pipeline; given the same author and input it
 * is byte-stable.
 */
export function createAssumptionCompiler(author: CandidateAuthor): AssumptionCompiler {
  return {
    compile(input: CompileAssumptionsInput): CompiledAssumptionSet {
      const candidate = author(input);
      // Family gate, before hashing or diffing: cross-check every binding's
      // target family against the run's catalogue, mirroring resolveAssumptions'
      // exact-string membership test so the compile-time and run-time gates
      // cannot disagree. A hallucinated family dies here, on the show-before-run
      // surface, rather than surviving to the diff and failing only at run time.
      const knownFamilies = input.families.map((f) => f.id);
      const known = new Set(knownFamilies);
      const familyById = new Map(input.families.map((f) => [f.id, f]));
      for (const binding of candidate.bindings) {
        if (!known.has(binding.familyId)) {
          throw new UnknownFamilyError(binding.familyId, knownFamilies);
        }
        // Compatibility gate (D5 mirror): the same shared check the run-time
        // resolveAssumptions applies, so compile-time acceptance implies
        // run-time acceptance for this class of error.
        // A registered overlay has no entry in the built-in
        // compatibility table: which instrument types its kind can drive is the
        // registering plugin's business, and the compiler holds no mounted
        // context to ask. The run-time gate in resolveAssumptions still refuses
        // a kind no plugin registered.
        if (binding.overlay.kind === "registered") continue;
        const familyDef = familyById.get(binding.familyId)!;
        checkOverlayCompatibility(
          binding.familyId,
          binding.overlay.kind,
          familyDef.instrumentType,
          overlayModelOf(binding.overlay),
        );
      }
      // Validate + hash. Throws AssumptionValidationError on a malformed set,
      // so an unfinished or broken candidate never becomes a plausible object.
      const assumptionSet = bindAssumptions(candidate);
      const diff = diffAssumptions(input.base, assumptionSet);
      const rationale = buildRationale(input.instruction, diff);
      return { assumptionSet, diff, rationale };
    },
  };
}

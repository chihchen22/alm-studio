/**
 * Provenance ledger surface. Assembles the ProvenanceRecord from run inputs and
 * derives the kernel reference from the vendored PROVENANCE.md manifest.
 */
export { assembleProvenance } from "./assembleProvenance";
export type { ProvenanceContext } from "./assembleProvenance";
export { parseKernelProvenanceRef, readKernelProvenanceRef } from "./kernelRef";

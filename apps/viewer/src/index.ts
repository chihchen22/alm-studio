/**
 * @alm/viewer: React + Vite reader over engine output.
 *
 * Scaffold for the interface-freeze wave: the viewer consumes a RunResult and
 * never computes one. It re-exports the result type it renders so the wiring
 * typechecks. The build wave adds React, Vite, and one chart library, plus the
 * components; those dependencies are added then, not now.
 */
export type { RunResult } from "@alm/engine";

# ALM Studio engine: Architecture

This document describes the engine's interfaces. It is the contract, not a sketch. The types live in `packages/engine/src/contracts/`; this prose explains why they are shaped the way they are and how the layers fit.

The one-line thesis: the kernel already computes one instrument correctly. This engine is the aggregation, scenario, and reporting layer above that atom, plus a surface that a language model can drive without ever doing arithmetic on the book.

---

## 1. Packages and dependency direction

Four layers, one direction of dependency. Nothing downstream is imported upstream.

```
@alm/kernel   vendored kernel math. Instrument, RatePath, Cashflow, the concrete
              instruments, the rate machinery, the behavioral models,
              the analytics. Frozen; hash-verified in PROVENANCE.md.
     ^
@alm/engine   the new work. Chart of accounts, positions, scenarios, assumption
              sets, the static and dynamic cash-flow engines, NII, EVE, gap,
              attribution, the provenance ledger, the typed tool surface. A pure
              library: no DOM, drivable from Node and Vitest, callable from MCP.
     ^                          ^
@alm/ai       @alm/viewer / @alm/data
the AI-native surface           React reader over results; seeded data generator
(tool impl, NL compiler,        (both consume engine types, never kernel math
 explain, MCP server)            directly for computation)
```

`@alm/engine` imports only `@alm/kernel`. `@alm/ai`, `@alm/viewer`, and `@alm/data` import `@alm/engine` (and the kernel for terms and RNG). The contract layer (`packages/engine/src/contracts/`) imports only `@alm/kernel` types. This is the structure an API-first design asks for: a core with the GUI as one client, not the source of truth.

The kernel is vendored, not cross-imported, so the two apps ship independently and a Windows relative-import into a sibling Vite project never enters the picture. The cost is a future re-sync, kept cheap by an exact per-file hash manifest.

---

## 2. Position and chart-of-accounts model

A balance sheet is not a flat `Instrument[]`. Results have to aggregate along the dimensions an ALCO asks about, so the position layer carries two things the kernel's atom does not: a place in a hierarchy, and a separation between what is observed and what is assumed.

**Chart of accounts** (`chartOfAccounts.ts`). The COA is the spine conventional ALM systems get right: an account is a node in a summation tree that also classifies the instruments beneath it. This version keeps the tree (`CoaNode` with `parentId`, `side`, `order`) and the family classification, and drops the other jobs those systems overload onto one account: posting router, calc-order group, GL pointers. Roll-up is by summing a node's children. Positions attach only to leaf nodes. Alternate views (management vs regulatory) are a known omission, recorded in the limitations register, not built now.

**Product family** (`ProductFamilyDef`). A family is the ALCO-facing label: DDA, MMA, Savings, Fixed Loans, Floating Loans, Mortgages, MBS, Investments, CDs, FHLB Advances, Borrowings. A family declares which kernel instrument type its positions instantiate. The frozen kernel has five instrument types; the synthetic book has roughly eleven families. Several families share one instrument type: a CD and an FHLB advance are both bullet fixed-rate liabilities that differ in COA placement and behavioral overlay, not in cash-flow engine. This mapping is the honest way to cover the book without touching the frozen `InstrumentType` union.

**Position** (`Position`). A position is a plain data record: an id, a family, a COA leaf, and the kernel `terms`. Two properties are load-bearing:

- It holds `terms`, not a live `Instrument`. The engine builds the concrete instrument from `terms` inside the cash-flow loop and discards it at once. One hundred thousand positions cost one hundred thousand small records, not one hundred thousand retained objects with attached result arrays. Section 8 explains why this is the whole performance story.
- It embeds no behavioral parameters. The overlay that applies is resolved from the run's assumption set by `familyId`. This keeps source data and assumptions in separate typed layers: a position is an observed fact; an assumption is a separate, swappable layer.

A `PortfolioSpec` carries the COA and the positions together as of one date, so the whole book hashes as a single input snapshot for provenance.

---

## 3. Scenario and assumption-set model

The split here is deliberate and it is the premise of the AI layer: **rate environment and behavior are separate objects, and the behavioral object is data**.

**Assumption set** (`assumptions.ts`). An `AssumptionSet` is a serializable, diffable list of `OverlayBinding`s, each attaching one behavioral overlay to one product family. The overlays wrap the exact parameter blocks the vendored kernel models consume: `MBSParams` for prepayment, `NMDParams` for decay, `BetaSCurveParams` for deposit repricing beta, and a small rollover block for CDs. Because the overlay carries what the kernel actually runs, a compiled set is directly executable; no translation layer sits between what the AI writes and what the kernel computes.

The assumption set is DATA, not code, and that is the point. The natural-language layer's entire job is to author this object (Section 6). It has a stable JSON shape (`schemaVersion`, a stable `id`, a `bindings` array), and an engine-populated `contentHash` that is never authored by hand. Two assumption sets diff field by field into an `AssumptionDiff`, which is what the show-before-run step renders.

**Scenario** (`scenario.ts`). A `Scenario` is a rate spec plus an assumption-set reference plus a new-business strategy. The `RateSpec` covers base, parallel (the IRRBB grid), and non-parallel twist. `REGULATORY_SHOCKS_BP` pins the five parallel points every run covers: base, plus and minus 100, plus and minus 200. The base curve is bootstrapped from the run's market snapshot; the spec says how to shock it.

Keeping the rate spec and the assumption set as separate references means the same assumption set runs under every shock in the grid, and the same rate shock runs under a stressed and an unstressed assumption set. That cross-product is exactly the ALCO question, and a dialog-driven system makes you assemble it by hand across modal forms.

---

## 4. Static and dynamic balance sheet

One field, not two engines. Static and dynamic runs are often separated more than the mathematics requires; the cash-flow core is identical and only the new-business strategy differs.

- **Static runoff** sets `NewBusinessStrategy.mode = "static"` with no rules. The existing book runs off under the scenario's rate path and behavioral overlays. This drives EVE and both gap ladders.
- **Dynamic** sets `mode = "dynamic"` with `NewBusinessRule`s that reinvest runoff, hold a family balance flat, or grow it. New-business coupon is the reinvestment index plus a spread. This drives projected NII over 12 and 24 months.

Both modes call the same per-position generator and the same bucket aggregator. The dynamic mode adds reinvestment tranches to the same accumulators. When a runoff target cannot be hit because contractual runoff already exceeds it, the strategy under-hits and the shortfall is reported, never silently absorbed; a silent under-hit is a rejected behavior.

---

## 5. Run lifecycle and provenance ledger

`run()` takes a `RunRequest` and returns a `RunResult`. The request carries the portfolio id, the market snapshot, the scenarios, the assumption sets, the bucket grid, the seed, and the timestamps. The timestamps are supplied by the caller, not read from a clock inside the compute path. That single decision is what lets the core stay deterministic while the ledger still records when the run happened.

The lifecycle:

1. **Resolve.** Look up the registered portfolio, bootstrap the base curve from the snapshot, resolve each scenario's assumption set, build the concrete kernel behavioral models from the overlay params.
2. **Project and bucket.** For each scenario, generate cash flows position by position under that scenario's rate path, reducing into typed-array bucket accumulators keyed by family and month (Section 8).
3. **Report.** Compute NII, EVE, both gap ladders, and the attribution decomposition from the bucketed aggregates and per-family PVs.
4. **Stamp.** Emit the `ProvenanceRecord`: the inputs hash, the seed, the assumption-set ids and hashes, the kernel provenance reference, the model versions, and the injected timestamps.

**Provenance ledger** (`provenance.ts`). Every run emits one machine-readable record so any number on any screen traces back to the inputs and assumptions that produced it. This is the SR 11-7 governance surface a GUI-bound system rarely offers, where a last-writer stamp and a clearable log stand in for an audit trail and stochastic runs are not reproducible from a stored seed. Here the `inputsHash` covers the full serialized input snapshot excluding timestamps, so two runs with the same hash and seed produce byte-identical results, and the ledger is the artifact a model risk function asks for.

---

## 6. The AI-native surface

The tool surface (`tools.ts`) is the engine's primary interface. The viewer and the MCP server are both clients of it. Six typed, side-effect-explicit functions: `loadPortfolio`, `defineScenario`, `bindAssumptions`, `run`, `queryResults`, `explain`. Side effects are stated per method; `run` is pure given its request and the registered portfolio.

Two contracts encode the division of labor that makes the premise defensible:

- **Natural language to assumption set** (`AssumptionCompiler`). "Run a +200 parallel with MMA betas 15 points higher and prepayments at half speed" compiles to a typed `AssumptionSet` plus an `AssumptionDiff` versus the base, plus a plain-language rationale. The language model authors the object; it never computes a number. The compiled object is shown before it runs. A language model doing arithmetic on a balance sheet is a liability, so the contract makes that impossible: the compiler's output type is data, and only `run()` produces numbers.

- **Explain** (`Explanation`). "Why did NII fall 4% in +200?" is answered only from the `AttributionResult` the engine computed. The `explain` contract returns the attribution rows it cites and a `supported` flag; if the decomposition cannot support the question, `supported` is false and the answer says so. The model narrates a decomposition it was handed; it does not form an impression of the report.

**Unfinished layers** (`errors.ts`). A layer that is not built throws, or returns a `NotImplemented` tag that surfaces in `RunResult.notImplemented`. It never returns a plausible number. This is the anti-fabrication rule made structural.

**Construction surface** (`run/engine.ts`). `createEngine()` builds the concrete `EngineRuntime` that implements `EngineTools`, resolving an `EngineContext` (engine version, kernel provenance reference, and the `durationMode` measurement policy) once at construction and stamping the version fields into every run so the determinism gate holds across repeated runs. The `EngineContext` is deliberately separate from the frozen `RunRequest` contract: it carries runtime and provenance policy, not part of the request's serialized identity. A caller that wants base-only durations builds `createEngine({ ...resolveDefaultContext(), durationMode: "base-only" })`; the default `createEngine()` measures durations per scenario.

---

## 7. Result model

Every number lives in a typed shape and serializes to JSON with a stable schema (`results.ts`, `run.ts`). No number exists only as a rendered pixel. The stability strategy: a `schemaVersion` on the envelope, additive evolution, and no `NaN` or `Infinity` in serialized output.

- **Bucketed cash flows.** Per scenario, per family, and rolled up per COA node: balance, principal, and interest over the monthly grid. These are the typed-array accumulators, serialized as `number[]`.
- **NII.** Interest income, expense, and net at 12 and 24 months, per scenario, decomposed to family, with scenario totals.
- **EVE.** PV of assets and liabilities per scenario, EVE, delta versus base, and effective duration of equity. Every EVE scenario carries a `durationSanityPassed` flag: the rule that a surprising duration is a finding or a bug, checked before the number is trusted. The gate policy is per-environment: a family's positive-sign check applies only at the base environment, where an asset and a deposit both lengthen in value as rates fall; at shocked environments a behavioral family's effective duration is legitimately negative (the mortgage down-bump reaches the refi wave, the interest-bearing deposit up-bump reaches the steep part of the beta curve), so shocked environments gate on finiteness and magnitude only. Equity is gated on finiteness and magnitude everywhere. A family duration the gate rejects is left `undefined`, not patched. The equity duration is populated whenever it individually passes its own gate, even when `durationSanityPassed` is false because an unrelated family was rejected: suppressing a valid, computed number would discard information the flag already advertises as needing scrutiny. Where the durations are measured is a runtime option (`durationMode`): the default measures each scenario at its own environment; `base-only` measures once at the base environment and leaves the shocked scenarios' duration block empty (their `durationSanityPassed` is a vacuous true). Neither choice touches the EVE / Δ-EVE headline, which comes from the bucketed PV pass, not the duration engine.
- **Gap.** A repricing ladder off `Instrument.repricingSchedule()` and a liquidity ladder off principal cash flows, both bucketed into standard time bands and rolled up the COA tree, with cumulative gap per band.
- **Attribution.** Each headline delta decomposes into per-family, per-driver contributions, with the unexplained residual carried explicitly rather than absorbed into a driver. This is the input the explain layer narrates, and it is what makes the tool worth using.

All result collections are arrays in a stable order (declared family order, ascending node order, ascending bucket index), never Maps, so serialization does not depend on iteration order.

---

## 8. Performance: 100k positions x 360 months under 60 seconds

The target is deterministic and single-machine. The strategy, in order of importance:

1. **No per-position object churn in the hot loop.** A position is a POJO holding `terms`. The loop instantiates the concrete kernel instrument, calls `generateCashflows(path)`, and reduces the returned `Cashflow[]` straight into typed-array accumulators, then drops both. No array of per-position result objects is ever built. The accumulators are `Float64Array` of length `horizonMonths`, one set per (scenario, family), indexed by month bucket. Aggregation is a tight numeric add, not a map merge.

2. **Bucket by integer month offset.** Calendar monthly, 360-month horizon. A cash flow's `monthOffset` is its bucket index; no date arithmetic in the inner loop.

3. **Regenerate cash flows per shock, not per position per shock naively.** The EVE grid reuses the kernel's `effectiveDurationOnPaths` pattern: cash flows regenerate once per shock leg and PV-at-spread is cheap, so behavioral re-leveling comes through the bump without redundant work.

4. **Measure before optimizing.** The single-threaded typed-array path is the first cut and is expected to hold the target. Sharding positions across Web Workers is an embarrassingly parallel escape hatch with a deterministic reduce, taken only if measurement misses 60 seconds. The reversal condition is a measured overrun, not a guess.

If the prototype lands far off the target, the honest move is to say so in the limitations register, not to redefine the target.

---

## 9. Determinism

Determinism is a hard requirement, not a quality-of-life feature : it is the only way a reader can check the work, and the only posture a model risk function accepts.

- Same `RunRequest` plus same seed produce byte-identical results, timestamps excepted.
- No `Date.now`, no `Math.random`, no wall-clock read in any computational path. Timestamps are injected on the request.
- Every RNG routes through the kernel's `PCG32` seam (`rates/random.ts`), seeded explicitly. The headline deterministic run uses `DeterministicRatePath` and draws no randomness; only a stochastic (prudent-EVE) extension would.
- No map-iteration-order dependence in any result: collections are ordered arrays, and aggregation runs over positions in stable id order and families in declared order.

---

## 10. What the viewer and the MCP server consume

Both consume the same two things: the typed tool surface and the `RunResult` JSON. Neither computes a number.

- **The viewer** (`@alm/viewer`) renders `RunResult`: the NII and EVE tables, the gap ladders, the attribution waterfall, the provenance record, and the show-before-run diff of a compiled assumption set. It calls the tool surface to load, define, bind, run, and query. It never reaches into the kernel or recomputes a result.
- **The MCP server** (`@alm/ai`) exposes the same six tools over MCP so Claude Code or any MCP client drives the engine directly. This is the differentiator against any ALM system that has no automation surface at all. The server is a thin adapter over `EngineTools`; the compiler and explain layers sit beside it, and the explain layer answers only from attribution.

The dependency budget: React, Vite, Vitest, TypeScript, one chart library, and `@modelcontextprotocol/sdk`. Each enters with the code that needs it.

# The ALM Harness: an aggregator, not a model

The engine does not own the models. It owns the contract between them, the routing that says which
model may feed which number, and the dimensional record that lets any number be re-cut without a
rebuild. Everything that actually computes a behavior, a curve, or a rate path arrives as a component:
a module that carries the method, and a context file that carries the institution's calibration.

This document specifies the harness in five planes. It is the architecture the current engine grows
into, not a description of what it is today. Section 6 states plainly which parts exist, which are
partial, and which are not built.

---

## 1. Why an aggregator

An ALM engine is asked to produce four primary numbers (NII, EVE, the repricing gap, the liquidity
gap) from six classes of input that are modeled by entirely different disciplines:

- market quotes, which become curves, index projections, and term-structure models
- instrument contractual terms and borrower features, which become contractual cash flows
- behavioral assumptions, which become hazards and response functions
- balance targets and new volume, which become the going-concern book
- new business repricing assumptions, which price what the targets add
- rate and environment shocks, which define the scenario set

No single team builds all six. No single vendor keeps all six current. The failure mode of the
monolith is that it fuses them: the curve builder, the prepayment model, the chart of accounts, and
the regulatory report are compiled into one artifact, so changing any one of them is a change to all
of them. That fusion is why a reporting-layer rebuild is a twelve-month project.

The harness inverts the ownership. It fixes a contract and a routing policy, and treats every
computational component as replaceable. A bank that wants a different prepayment model swaps a
component. A bank that wants a different regulatory view writes a view definition. Neither touches
the engine.

---

## 2. The five planes

### Plane 1: Contract

The frozen interface every component plugs into. Units, signs, day count, the cash-flow shape, the
rate-path bridge, the position record, and the dimension bag. Nothing in this plane may change
without a version bump, because everything else is written against it.

The contract is deliberately small. It is not a data model for banking; it is the handful of shapes
that two independently built components must agree on to compose. The engine's `contracts/` directory
is the executable form of this plane.

The load-bearing decision is that a position is an observed fact and an assumption is a separate,
swappable layer. A position record carries terms and dimensions. It carries no behavioral parameter.
The overlay that applies to it is resolved at run time from the assumption set. This is what makes a
component swap a data change rather than a migration.

### Plane 2: Inputs, as context files

Every input to a run is a file, versioned and hashable, never a screen state:

| Input | Carries |
|---|---|
| Market snapshot | Curve quotes, cap and swaption vol surfaces, funding curves, TLP nodes |
| Position book | Contractual terms, borrower features, the dimension bag per position |
| Dimension taxonomy | The declared dimensions and their allowed values |
| Assumption set | Behavioral overlay bindings, one per selector |
| Balance plan | Target balances, new volume, mix shift, new-business repricing rules |
| Scenario set | Rate specs, environment shocks, the assumption set each scenario runs |

The whole set hashes into one input snapshot, which is what makes a run reproducible and what makes
two runs comparable. A number a bank cannot trace to a hashed input snapshot is not a result, it is
an anecdote.

### Plane 3: Components, as a library

A component is a stage with a declared interface: what it consumes, what it produces, what parameters
it takes, and what governance tier its output carries. The library covers seven stage kinds:

1. **Market data intake.** Quotes to a typed snapshot.
2. **Curve construction.** Quotes to a discount and forward curve.
3. **Term structure and index.** Curve to rate paths, deterministic or stochastic, plus the basis and
   index projections a floating book reprices off.
4. **Contractual cash flow.** Position terms plus a rate path to a contractual cash-flow stream.
5. **Behavioral overlay.** Prepayment, decay, deposit beta, draw, early withdrawal. Consumes the
   contractual stream and a rate path; produces the behavioral stream.
6. **Balance and new business.** Target balances, new volume, mix, and the repricing rules that price
   what is added. This is what converts a runoff book into a going-concern book.
7. **Metric.** NII, EVE, repricing gap, liquidity gap, FTP, SEG.

A component declares its interface; it does not declare where it may be used. That is the next plane's
job, and separating the two is the point.

### Plane 4: Composition and the routing gate

A run plan is a directed graph of component instances, authored by a human or by an AI agent, and
validated before anything executes. Validation has two independent gates.

**The type gate** checks that the graph composes: every stage's declared inputs are produced by an
upstream stage or supplied by a context file, units and sign conventions agree, and the grid and as-of
date are consistent across the plan.

**The routing gate** checks that the graph is *allowed*. This is the model map made executable. The
map states, per behavioral class and per metric, whether the class feeds that metric as a model (M),
as a management assumption (A), or not at all. A plan that routes a decay model into NII, or a
deposit beta into a runoff gap, fails the gate and says which rule it broke.

This is the mechanism that turns the model map's central claim into software. The most common failure in
behavioral modeling is not a wrong functional form, it is a sound model routed to a metric it cannot
support, and that error survives silo validation because each model validates cleanly on its own
bench. A gate that runs at composition time catches it before a number exists.

The routing policy is institution-specific data, not engine code. A bank whose FTP framework
deliberately diverges from its EVE valuation edits the policy; the gate then enforces the bank's map
rather than the shipped illustrative example.

The agent's role is bounded exactly as the existing assumption compiler bounds it. The agent
authors the plan, which is data. It never computes a number. The plan is shown before it runs, the
gates report what they checked, and only execution produces figures.

### Plane 5: Results, dimensions, and lenses

This is the plane that decides whether the reporting rebuild takes a week or a year.

**Late aggregation.** Every result row carries the full dimension bag of the position it came from.
The engine does not aggregate into a chart of accounts and then report off the aggregate. It computes
at position grain and keeps the dimensions, so a report is a query over result rows rather than a
different run.

**Views are definitions, not builds.** A chart of accounts is one hierarchy over the dimension bag. A
management view, a regulatory view, and a business-line view are three hierarchies over the same bag,
declared as view definitions. Adding a regulatory view is writing a definition and validating that it
partitions the book. It is not a remapping project, because nothing downstream was ever compiled
against the old hierarchy.

**Pivoting is a query.** Any result can be cut by any declared dimension, or by a cross of them,
without re-running. This is the capability whose absence forces banks to maintain a legacy process
purely to satisfy one report.

**Lenses.** The same result set is read through four objectives that trade against each other:
liquidity, interest-rate risk, capital, and management strategy. A lens is a scoring function over
result rows plus the constraints that lens imposes. True balance-sheet optimization requires all four
readable off one run, because an action that improves one commonly degrades another, and a bank that
can only see one lens per run cannot see the trade.

---

## 3. The dimension model

The engine today attaches each position to a single chart-of-accounts leaf. That single attachment is
the thing to break, because it forces one hierarchy to serve every question.

Replace it with a dimension bag: a set of key-value tags on the position, drawn from a declared
taxonomy. The dimensions a US commercial bank actually pivots on:

| Dimension | Example values | Used by |
|---|---|---|
| Product family | DDA, MMA, Savings, CD, Mortgage, MBS, FHLB | Every view |
| Balance-sheet side | Asset, liability, equity, off balance sheet | Every view |
| Legal entity | Bank, holding company, subsidiary | Regulatory |
| Business line | Consumer, commercial, treasury | Management |
| Rate type | Fixed, floating, administered, non-earning | IRR |
| Behavioral class | The eight classes of the model map | Model governance |
| Regulatory bucket | LCR category, IRRBB currency, call report line | Regulatory |
| Granularity tier | Modeled, assumption, monitor-only | Governance |
| Vintage, segment | Origination cohort, rate-shopper vs relationship | Calibration |

The rule that keeps this honest: a view definition must partition the book. Every position lands in
exactly one node of every declared view, and the harness checks that at load time rather than
discovering it in a footing difference at quarter end.

Behavioral class is the exception, and the exception is instructive. A single balance can be governed
by more than one behavioral model: high-yield savings is governed by both decay and deposit beta,
the pair that carries most of a deposit book's rate risk, and investment securities by both prepayment and the
reinvestment rate. Behavioral class is therefore many-to-many, and a view built on it double counts
by construction. That is precisely why the model map is a routing policy rather than a hierarchy: it
is a relation between models and metrics, not a partition of the book, and forcing it into a tree is
how a chart of accounts ends up unable to answer a model-risk question. The taxonomy carries it as a
multi-valued dimension, every view declares whether it partitions, and a non-partitioning view states
its double counting rather than quietly footing to the wrong number.

This also fixes what a component binds to. A selector binds on the multi-valued dimension, so one
position can legitimately be matched by two behavioral stages, a decay stage and a beta stage, and
that is the architecture working rather than a collision to resolve.

The behavioral-class and granularity-tier dimensions deserve a note, because they are the ones vendor
platforms do not carry. They make the model map queryable against the actual book: which balances are
behind a Tier 1 model, which are on a management assumption, and what a metric would move if a given
assumption were wrong. That is the model-risk question, and it is answerable only if governance
disposition is a dimension of the result rather than a spreadsheet maintained beside it.

---

## 4. What a component must declare

A module becomes a usable component by declaring five things. This is the whole registration contract:

- **Stage kind**, from the seven in Plane 3.
- **Consumes**, as named contract types.
- **Produces**, as named contract types.
- **Selector**, the dimension predicate the component binds to. This replaces binding by family id and
  is what lets one behavioral model apply to a segment rather than a whole family.
- **Governance disposition**, model or assumption, plus the tier. This is what the routing gate reads
  and what the result rows inherit.

Nothing in the declaration says where the component may be used. Capability and permission stay
separate: the component says what it can do, the routing policy says what it is allowed to feed.

---

## 5. The AI agent's contract

The agent composes; it does not compute. Concretely it may author the run plan, choose
components from the library, propose selectors and parameters, and narrate a decomposition the engine
produced. It may not produce a figure, silently substitute a component, or bypass a gate.

Three properties make that boundary enforceable rather than aspirational:

1. The plan is data with a stable schema, so it can be diffed against the last approved plan and shown
   before it runs.
2. The gates run on the plan, not on the output, so a bad composition is refused before it costs a
   run.
3. An unbuilt layer throws or returns an explicit not-implemented tag. It never returns a plausible
   number.

The third is the anti-fabrication rule the engine already enforces, and it is the one that matters
most when an agent is driving.

---

## 6. Honest state

| Plane | Status |
|---|---|
| Contract | Built. `contracts/`. |
| Inputs | Built for market, positions, assumptions, scenarios. The balance plan is a first-class input: declared target paths that are flat or single-geometric lower onto the existing new-business rule; any other shape is refused at compile time. |
| Components | Built (seams; registry of built-ins, user plugins by profile row): seven seams on a plugin context (curves, rate paths, behavioral kinds, positions, scenario libraries, metrics, run log), every built-in mounted by one profile row exactly as a user plugin is, and the behavioral union open to registered kinds. The catalog holds twenty-seven built-in plugin ids: twenty-two across the seven seams, the two gate plugins (`engine.gate.type`, `engine.gate.routing`), and three declare-only pipeline-stage rows (`engine.contractual`, `engine.tlp-overlay`, `engine.balance-plan`) that register nothing and exist so the type gate has honest producers for the stages the pipeline itself executes. |
| Composition | Built: the plan's graph drives the run. A walker sorts the plan's stages, resolves every consumed type to one producer in the consumer's own `dependsOn`, reads and writes an artifact shelf, and logs one entry per stage. A stage absent from the plan does not run. A plan-less request derives a default plan from itself and walks that, so there is one code path. The compiler licenses every behavioral binding to exactly one stage, requires a producer for each of the three mandatory results, and compares every executed stage's declares against its mounted plugin's. |
| Routing gate | Built for R1 to R4 against `model-map.json` and the book. A family's classes are the union of what it declares (`ProductFamilyDef.behavioralClasses`) and what the run's overlay bindings imply. R3 and R4 read the bag per position: a position's classes are its family's, the run's bindings', and its own `behavioralClasses` tag. |
| Results | Built at position grain with typed results. A run may declare views and the result carries CELLS: one family pinned to one value of each grouped tag, with a per-cell arm on the cashflow, NII, EVE and gap blocks. Family and COA roll-ups are unchanged and every scenario total still folds over families. Beside the stored envelope there is an ON-DEMAND read at position grain: one position, picked from a stored book or hand-typed, projected under one or more deterministic scenarios into its monthly schedule (path rate, coupon, balance, principal, interest, payment) with its PV on both bases, its in-horizon WAL and a single-instrument effective duration, computed live and never stored, so a stored run still carries no per-position series. Every finished run also keeps a RATE DOCUMENT beside its envelope, `rates.json`: the base zero curve, one shocked zero curve and one monthly rate path per scenario, rebuilt after the run from the request by the same functions the run used, and on a stochastic run the short-rate fan (mean and five quantiles per step) of the base scenario; served at `GET /api/runs/:id/rates`, never merged into the envelope. The viewer's Results page draws that document on a Rates tab: zero curves per scenario, the monthly rate path per scenario, and the stochastic fan. The Data page's Market tab draws each snapshot's cap and swaption ATM vol surfaces as heatmaps over the catalog market route, and the Rates tab links to the run's snapshot by its refs.marketId. The Results page shows a run's custom metric block on a Metrics tab, painted only when the envelope carries one: one table per metric, one bar chart per key, family rows collapsed, absent values shown as unobservable. |
| Dimensions | Built for the reporting half: a position carries a bag of declared tags, the taxonomy lives in the book, a binding or a stage selector may state a predicate over the tags, and a run may declare views the engine accumulates at. A view that cannot partition the book is refused naming the view, the dimension and the position. A pure pivot rolls cells up along a view on read, served at `GET /api/runs/:id/pivot`. FTP rows and attribution carry no cells. The viewer reads licenses, bindings, predicate-labelled diff rows and pivots with cell drill-down, and an over-budget view refuses at compile as a 422; CSV intake of tags and L1 on per-position classes are later work. |
| Lenses | Built read-side. A lens is DATA: a stored definition naming constraints over a closed set of six readers, with six lenses seeded as demonstration limits and edited without code. One route scores a finished run through one lens, a second through every stored lens, and both recompute nothing: every value is a field the envelope already carries. Each constraint reports its value, its limit, its headroom and one of pass, breach or unobservable; the capital lens is unobservable by construction until a capital component exists. The delta readers anchor to the one `base` scenario of the run's own request, never to a zero delta. There is no write route and the viewer is untouched. The fifth metric slot is a CUSTOM METRIC OF FIXED SHAPE: a plugin registers one under an id of its own, one plan stage per plan runs it over `Cashflow` and `Position`, the walker checks the shape and fails the run on a break, and the envelope carries it under `custom[<metricId>]`. One demonstration plugin ships mounted and runs only when a plan names it, a sixth reader (`customValue`) reads one named value of it, and the headline is fraction basis only, so an absolute-basis constraint drives status and never the headline. A second built-in custom metric is, `wal-gap`, the first real metric through the slot: the principal-weighted in-horizon average life of the pooled asset and liability families in months, their gap and their ratio, mounted beside the demonstration metric and run only when a plan names it. A third is `survival-horizon`, the first liquidity metric through the slot: the whole months a buffer of `hqla-level`-tagged asset families covers the book's cumulative net outflow as each scenario projects it, run only when a plan names it; the liquidity stress is engine input, a seeded ILLUSTRATIVE assumption set of constant deposit run-off, not a table in the metric. A fourth and fifth are `lcr-scenario` and `lcr-regulatory`: the same buffer after the US Level 2 caps over month-1 net outflow, read from each scenario's projected flows or from the US rule's run-off rates on an `lcr-category` tag, run only when a plan names them, either or both. |

The shortest path from here is not to build all of it. The plan object, the two gates, the
executor, the per-position selector, late aggregation, the lens reading and now the fifth metric
slot all exist. What is missing is not plumbing: it is components. The reading of one run through
liquidity, rate, capital and strategy stays plumbing rather than coverage, because two of those
four objectives still have no components at all, which is why the capital lens reports its one
constraint as unobservable and says why, and the component gaps the next subsection describes
are what a fifth metric slot now has somewhere to put.

### The component gaps

The two stage kinds an aggregator cannot fake are the ones that had no owning component. The first
has since moved into the engine as a plan input; the second is still open:

**Balance targets and new business: the engine carries it as a plan input.** The balance plan is a
first-class plan input: declared target paths that are flat or single-geometric lower onto the
new-business rule, per scenario or plan-wide, and the compiler refuses any other shape
(`BalancePlanUnsupported`). Provenance stores the plan hashes (`provenance.scenarioBalancePlanHashes`
and `provenance.balancePlanHash`), and a dynamic scenario that cannot reach a target stores a
shortfall row. A going-concern earnings projection therefore runs for the shapes the plan accepts,
and a book without a balance plan still runs off.

This was the model map's new-volume row, and it is the row that carries the NII assumption. What is
still open is narrower than a missing stage, and `docs/guide/limitations.md` lists each limit: the
rule carries one growth rate per family, it originates and never sells so a target below the runoff
path ends above target, and growth scales an existing book but cannot seed a family from zero.

**Scenario definition has no owning component.** Shocks are well specified but scattered across five
places: the two shocked-path classes in the conventions, the regulatory grid and key-rate bumps in
EVE, the earnings-at-risk default in NII, a hard-coded and non-configurable 10bp in SEG, and a
steepener and flattener set in the replicating portfolio. There is no scenario schema, no scenario
library, no ramp-versus-immediate distinction, and no macro layer, even though the competing-risks
model consumes a house-price stress path and the mortgage chain emits one.

A composer needs a scenario object to compose against. The library does not define one, so the harness
has to.

Two further gaps bear on the optimization thesis directly. A book can carry plain
vanilla interest rate swaps as positions, so a bank that hedges with swaps can represent them; caps,
floors and swaptions still cannot be represented, and callable structures are explicitly unsupported.
And liquidity risk stops at the gap
and one survival metric: there is no LCR, NSFR, or contingency funding plan, and there is no capital
metric at all. The survival horizon reads a stress the engine projects. Optimizing across liquidity, interest-rate risk, capital, and management strategy needs four
lenses readable off one run. Two of the four currently have no components.

---

## 7. Where the pieces live

- `catalog.json`: the component library, one entry per registered stage.
- `model-map.json`: the routing policy as data, an illustrative worked example an institution edits.
- `packages/harness`: the plugin kernel. Services on a context, inject-driven activation, three
  dispatch modes, profile rows and their hash. No dependency.
- `packages/engine/src/plugins/`: the built-in catalog and the default profile, one row per
  built-in, plus the seam services the run reads through.
- `packages/engine/src/run/executor.ts` and `run/shelf.ts`: the walker and the artifact shelf.
  `run/stages/` holds one function per stage kind, each wrapping by reference the code the
  pre-1c pipeline ran inline.
- `packages/engine/src/instrument/projectInstrument.ts`: the single-instrument drill. Pure, no
  store, no clock; composes the curve, path, instrument, WAL and discount seams the static pass
  uses, and adds no model.
- `POST /api/instrument/project` (`apps/server/src/http/routes/instrument.ts`): the drill's one
  route. Resolves stored ids into the drill's input, answers the schedule and its valuation, and
  writes nothing: no run id, no queue entry, no catalog row.
- `packages/engine/src/rates/rateDocument.ts`: the rate document builder. Pure; recomputes the
  base curve, the per-scenario shocked curves and the monthly deterministic paths from the request
  with the seams the run used, and summarises a Hull-White simulation into a per-step fan.
- `GET /api/runs/:id/rates` (`apps/server/src/http/routes/runs.ts`): the rate document, served
  verbatim from `rates.json`, which the runner child writes after `result.json` on both arms.
- `apps/viewer/src/components/RatesPanel.tsx` and `apps/viewer/src/rateChartRows.ts`: the Rates
  tab. The rows module (tested) scales stored document fields to percent and builds the fan's band
  pairs; the panel draws three charts with a legend, a tooltip and a collapsed values table each,
  and computes no statistic.

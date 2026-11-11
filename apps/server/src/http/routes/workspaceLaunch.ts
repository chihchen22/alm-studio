/**
 * Setup validate and launch (Studio A+E spec v3.1 Sections 3.5 and 5.2; contracts 1, 2
 * and 15; plan Task C3):
 *
 *   GET  /api/workspaces/:id/readiness                   the readiness report (workspaces/readiness.ts)
 *   POST /api/workspaces/:id/setups/:lineageId/validate  { by }
 *   POST /api/workspaces/:id/setups/:lineageId/launch    { by, acknowledge?, batch? }
 *
 * Both read the slot's current setup document as stored bytes and refuse 409 when they
 * no longer hash to the slot's pin, then compile through `compileSetupRow`.
 * Neither writes the setup document or the manifest: a validation and a launch are lines
 * in `workspaces/<id>/setups.ndjson`, a launched run a line in `runs.ndjson`.
 *
 * Launch order, under the workspace lock (Section 5.2 "Launch counter and batch order"):
 *  1. Compile every row (the setup itself, or each batch row with `batch: true`); no writes.
 *     A failing batch row is a 422 carrying every row's report, and nothing is written.
 *  2. The launch gate: blocking and acknowledgeable readiness items (below). A 409 lists both.
 *  3. `launchNo` is the count of this slot's `launch` lines plus one; append the `launch` line.
 *  4. Per row in order: write or reuse the launch slate, pin it in the `slate` role, and call
 *     `submitRun` with the workspace stamp, which hashes every document it reads against the
 *     consumed pins before `request.json` is written. Each 202 appends an attachment line. A
 *     refusal stops the batch at that row; rows already queued stay queued (risk 18 of the
 *     v3 spec: a queued run records what was asked, so it is offered for cancel, never
 *     auto-cancelled).
 *  5. Append `launch-complete`. 200 when nothing failed; 207 with a cancel offer per queued
 *     run when a later row was refused; the refusal's own status when no run was queued.
 *
 * The launch gate is `launchable[slot]` of the shared readiness report (workspaces/readiness.ts):
 * blocking items are Error, required Not set, and a Stale setup on a Production workspace (the
 * month a sign-off will bind launches only on the pins it validated); acknowledgeable items are
 * Stale and Warning. A setup whose compile carries warnings is acknowledgeable under
 * "run/setup-warnings" even before its first validation, because the compile at launch is the
 * validation that counts; Stale stays under "run/setups", so one acknowledgement never covers the
 * other (review C m2). The Production-Stale block is a recorded deviation from spec Section 3.5
 * ("Slice 1 deviations"). A setup asking for the stochastic EVE path is refused
 * 422 `stochastic-path-reserved` by the compile, before the gate (review C M1).
 *
 * `{ mode: "stochastic" }` launches the setup's stochastic choice (`eve.stochastic`)
 * instead, through the same lock, launch counter, launch lines and pin checks (`compileStochasticSetup`): a base-only
 * launch slate, the run route's stochastic arm with the workspace stamp, and an attachment line marked
 * `mode: "stochastic"` with the setup document it ran. Its gate is the readiness report's blocking and
 * acknowledgeable items outside the Run section (the Run setups items judge the deterministic compile and its
 * validations, which a stochastic run does not read). It takes no batch.
 */
import { readFileSync } from "node:fs";
import type { PlatformContext } from "../../context";
import { COLLECTIONS, assertValidId, type Collection } from "../../store/paths";
import { NotFoundError, sha256Hex, writeFileAtomic } from "../../store/store";
import { assertWritable, requireBy } from "../../workspaces/rules";
import { computeReadiness, computeReadinessDetail, RUN_SETUP_WARNINGS_ITEM, RUN_SETUPS_ITEM } from "../../workspaces/readiness";
import { assembleSetupPlan, compileSetupRow, compileStochasticSetup, PENDING_PLAN_ID, stochasticBaseScenario, type CompiledSetupRow, type SetupRow } from "../../workspaces/setupCompile";
import type { Scenario } from "@alm/engine";
import type { ConsumedPins, RunAttachment, RunSetup, SetupEvent, SetupSlot, WorkspaceManifest } from "../../workspaces/types";
import { conflict, notFound, toHttpError, unprocessable, type HttpError } from "../errors";
import type { RouteResult, Router } from "../router";
import { assertOneBaseScenario, writeOrReuseLaunchSlate } from "./plans";
import { submitRun } from "./runs";

type Body = Record<string, unknown>;

export { RUN_SETUP_WARNINGS_ITEM, RUN_SETUPS_ITEM };

/** How many stored validations the history route serves, newest first. */
const VALIDATION_HISTORY_LIMIT = 20;

function bodyOf(raw: unknown): Body {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw unprocessable("the request body must be a JSON object");
  return raw as Body;
}

function slotOf(head: WorkspaceManifest, lineageId: string): SetupSlot {
  const slot = head.blocks.run.setups.find((s) => s.setupLineageId === lineageId);
  if (slot === undefined) throw notFound(`workspace "${head.id}" has no run setup slot "${lineageId}"`);
  return slot;
}

/** The slot's setup document, read as stored bytes and refused 409 unless they hash to the slot's pin. */
function readSetup(ctx: PlatformContext, slot: SetupSlot): RunSetup {
  const ref = slot.current;
  let bytes: Buffer;
  try {
    bytes = ctx.store.getDocumentBytes(ref.collection, ref.id);
  } catch (err) {
    if (err instanceof NotFoundError) throw conflict(`pin setup "${ref.id}" moved: the slot pins ${ref.contentHash}, and no such document is stored`);
    throw err;
  }
  const actual = sha256Hex(bytes);
  if (actual !== ref.contentHash) throw conflict(`pin setup "${ref.id}" moved: the slot pins ${ref.contentHash}, its bytes hash ${actual}`);
  return JSON.parse(bytes.toString("utf8")) as RunSetup;
}

function errorValue(h: HttpError): { code: string; message: string; detail?: unknown } {
  return { code: h.code, message: h.message, ...(h.detail !== undefined ? { detail: h.detail } : {}) };
}

/** The gate sentences of one stored gate report: each failure's `detail` string, in order; none when the shape differs. */
function failureDetails(report: unknown): string[] {
  if (typeof report !== "object" || report === null || !("failures" in report) || !Array.isArray(report.failures)) return [];
  const failures: unknown[] = report.failures;
  return failures.flatMap((f) => (typeof f === "object" && f !== null && "detail" in f && typeof f.detail === "string" ? [f.detail] : []));
}

/**
 * Why a stored validation failed, read from its stored `reports` (Studio Part 2 D11): the refusal's message when a
 * compile refusal was stored, then each type and routing gate failure's sentence; a validation that compiled but was
 * held by readiness carries the gate sentences and then `blocked by <id, id>` from `readiness.blocking`. All parts are
 * joined with "; ". Undefined when the reports hold none of these (a pass, or a line that stored none). Reads only;
 * the stored line is unchanged.
 */
function storedValidationReason(reports: unknown): string | undefined {
  if (typeof reports !== "object" || reports === null) return undefined;
  if ("error" in reports) {
    const error = reports.error;
    if (typeof error !== "object" || error === null || !("message" in error) || typeof error.message !== "string") return undefined;
    const detail = "detail" in error && typeof error.detail === "object" && error.detail !== null ? error.detail : null;
    const sentences = detail === null ? [] : [
      ...("type" in detail ? failureDetails(detail.type) : []),
      ...("routing" in detail ? failureDetails(detail.routing) : []),
    ];
    return [error.message, ...sentences].join("; ");
  }
  const parts = [
    ..."type" in reports ? failureDetails(reports.type) : [],
    ..."routing" in reports ? failureDetails(reports.routing) : [],
  ];
  const blocking = "readiness" in reports && typeof reports.readiness === "object" && reports.readiness !== null && "blocking" in reports.readiness && Array.isArray(reports.readiness.blocking)
    ? reports.readiness.blocking.filter((b): b is string => typeof b === "string")
    : [];
  if (blocking.length > 0) parts.push(`blocked by ${blocking.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

interface Seam {
  collection: Collection;
  id: string;
  row: number | null;
}

/**
 * TEST SEAM (ALM_TEST_SEAMS=1 only): `testSeam: { moveAfterCompile: "<collection>/<id>", row? }` rewrites that
 * document's stored bytes (one added space inside the JSON) after the compile and before `submitRun` for the
 * named row (every row when absent), then restores them, so a test can prove the pin check inside submitRun.
 */
function parseSeam(raw: unknown): Seam | null {
  if (raw === undefined) return null;
  if (process.env.ALM_TEST_SEAMS !== "1") throw unprocessable(`"testSeam" is accepted only when the server runs with ALM_TEST_SEAMS=1`, { field: "testSeam" });
  const seam = raw as { moveAfterCompile?: unknown; row?: unknown };
  const target = typeof seam.moveAfterCompile === "string" ? seam.moveAfterCompile : "";
  const slash = target.indexOf("/");
  const collection = target.slice(0, slash);
  if (slash < 0 || !(COLLECTIONS as readonly string[]).includes(collection)) {
    throw unprocessable(`"testSeam.moveAfterCompile" must be "<collection>/<id>"`, { field: "testSeam.moveAfterCompile" });
  }
  if (seam.row !== undefined && (typeof seam.row !== "number" || !Number.isInteger(seam.row) || seam.row < 0)) {
    throw unprocessable(`"testSeam.row" must be a row index`, { field: "testSeam.row" });
  }
  return { collection: collection as Collection, id: assertValidId(target.slice(slash + 1)), row: typeof seam.row === "number" ? seam.row : null };
}

function withSeam<T>(ctx: PlatformContext, seam: Seam | null, rowIndex: number, fn: () => T): T {
  if (seam === null || (seam.row !== null && seam.row !== rowIndex)) return fn();
  const path = ctx.store.paths.documentPath(seam.collection, seam.id);
  const original = readFileSync(path);
  writeFileAtomic(path, original.toString("utf8").replace("{", "{ "));
  try {
    return fn();
  } finally {
    writeFileAtomic(path, original);
  }
}

type RowOutcome =
  | { label: string; outcome: "pass"; compiled: CompiledSetupRow }
  | { label: string; outcome: "fail"; error: HttpError };

function rowReport(r: RowOutcome): Record<string, unknown> {
  if (r.outcome === "fail") return { label: r.label, outcome: "fail", status: r.error.status, error: errorValue(r.error) };
  const c = r.compiled;
  return { label: r.label, outcome: "pass", planId: c.planId, basisLabel: c.basisLabel, skippedFamilies: c.skippedFamilies, warnings: c.warnings };
}

/** The stochastic arm of the launch, under the workspace lock (see the header). */
function launchStochastic(ctx: PlatformContext, id: string, lineageId: string, by: string, acknowledge: string[]): Promise<RouteResult> {
  const { store, workspaces: wsStore } = ctx;
  return wsStore.withLock([id], (): RouteResult => {
    const head = wsStore.head(id);
    assertWritable(head);
    wsStore.assertNoPendingLock(id);
    const slot = slotOf(head, lineageId);
    const setup = readSetup(ctx, slot);
    const compiled = compileStochasticSetup(ctx, head, slot, setup);

    const readiness = computeReadinessDetail(head, ctx, wsStore);
    const entry = readiness.report.launchable[slot.setupLineageId]!;
    const outside = (ids: string[]) => ids.filter((i) => !i.startsWith("run/"));
    const blocking = outside(entry.blocking);
    const acknowledgeable = outside(entry.acknowledgeable);
    const reasonOf = readiness.reasonById[slot.setupLineageId] ?? {};
    const unacknowledged = acknowledgeable.filter((a) => !acknowledge.includes(a));
    if (blocking.length > 0 || unacknowledged.length > 0) {
      const reasons = [...blocking, ...unacknowledged].map((i) => (reasonOf[i] !== undefined ? `${i}: ${reasonOf[i]}` : i));
      return {
        kind: "json",
        status: 409,
        value: {
          error: {
            code: blocking.length > 0 ? "launch-blocked" : "acknowledge-required",
            message: blocking.length > 0 ? `launch blocked by ${blocking.join(", ")}: ${reasons.join("; ")}` : `launch needs acknowledge: [${unacknowledged.map((a) => `"${a}"`).join(", ")}]: ${reasons.join("; ")}`,
          },
          blocking,
          acknowledgeable,
          staleRoles: [],
        },
      };
    }

    const events = wsStore.readSetupEvents(id);
    const launchNo = events.filter((e) => e.t === "launch" && e.setupLineageId === slot.setupLineageId).length + 1;
    wsStore.appendSetupEvent(id, {
      t: "launch",
      setupLineageId: slot.setupLineageId,
      setupDocId: setup.id,
      at: new Date().toISOString(),
      by,
      consumed: compiled.consumed,
      launchNo,
      acknowledged: acknowledge,
      batch: false,
      state: "submitting",
    });
    const runIds: string[] = [];
    const failed: Array<{ row: string; status: number; message: string }> = [];
    let refusal: HttpError | null = null;
    try {
      const slateId = writeOrReuseLaunchSlate(store, `stoch-${sha256Hex(compiled.assumptionSetId).slice(0, 12)}`, [stochasticBaseScenario(compiled.assumptionSetId) as unknown as Scenario]);
      const slateMeta = store.getMeta("scenario-slates", slateId);
      const consumed: ConsumedPins = { ...compiled.consumed, slate: { collection: "scenario-slates", id: slateId, contentHash: slateMeta.contentHash, pinnedAt: new Date().toISOString() } };
      const st = compiled.stochastic;
      const submitted = submitRun(ctx, {
        portfolioId: compiled.portfolioId,
        marketId: compiled.marketId,
        scenarioSlateId: slateId,
        assumptionSetIds: [compiled.assumptionSetId],
        gridHorizonMonths: setup.gridHorizonMonths,
        ...(st.seed !== undefined ? { seed: st.seed } : {}),
        mode: "stochastic",
        stochastic: {
          nPaths: st.nPaths,
          ...(st.model !== undefined ? { model: st.model } : {}),
          ...(st.modelParams !== undefined ? { modelParams: st.modelParams } : {}),
          ...(st.calibrationId !== undefined ? { calibrationId: st.calibrationId } : {}),
        },
        label: `${setup.name} #${launchNo} (stochastic)`,
        workspace: { workspaceId: id, setupLineageId: slot.setupLineageId, setupDocId: setup.id, launchNo, consumed },
      });
      const runId = (submitted as { value: { runId: string } }).value.runId;
      const attachment: RunAttachment = { runId, attachedBy: "launch", at: new Date().toISOString(), setupLineageId: slot.setupLineageId, launchNo, pins: "consumed", mode: "stochastic", setupDocId: setup.id };
      wsStore.appendRunAttachment(id, attachment);
      runIds.push(runId);
    } catch (err) {
      refusal = toHttpError(err);
      failed.push({ row: setup.name, status: refusal.status, message: refusal.message });
    }
    const complete: Extract<SetupEvent, { t: "launch-complete" }> = { t: "launch-complete", setupLineageId: slot.setupLineageId, launchNo, at: new Date().toISOString(), runIds, failed };
    wsStore.appendSetupEvent(id, complete);
    if (refusal !== null) return { kind: "json", status: refusal.status, value: { error: errorValue(refusal), ...complete } };
    return { kind: "json", status: 200, value: { ...complete, mode: "stochastic", notes: compiled.notes } };
  });
}


export function registerWorkspaceLaunchRoutes(router: Router, ctx: PlatformContext): void {
  const { store, workspaces: wsStore } = ctx;

  // GET /api/workspaces/:id/readiness: the report the chips, the Launch gate and the clone reply share.
  router.add("GET", "/api/workspaces/:id/readiness", (req) => ({
    kind: "json",
    value: computeReadiness(wsStore.head(req.params.id ?? ""), ctx, wsStore),
  }));

  router.add("POST", "/api/workspaces/:id/setups/:lineageId/validate", (req) => {
    const id = req.params.id ?? "";
    const lineageId = req.params.lineageId ?? "";
    const body = bodyOf(req.json());
    const by = requireBy(body);

    return wsStore.withLock([id], (): RouteResult => {
      const head = wsStore.head(id);
      const slot = slotOf(head, lineageId);
      const setup = readSetup(ctx, slot);
      let line: Extract<SetupEvent, { t: "validate" }>;
      let extra: { compiledChain: unknown[]; planId: string | null };
      const at = new Date().toISOString();
      try {
        const row = compileSetupRow(ctx, wsStore, head, slot, setup, null);
        const gatesPassed = row.gates.type.passed && row.gates.routing.passed;
        // The outcome reads the shared readiness report too: a warning on another item (a recorded cut-off
        // clash) makes the validation pass with warnings; a blocking item outside this setup's own item fails it.
        const gate = computeReadinessDetail(head, ctx, wsStore).report.launchable[slot.setupLineageId]!;
        const others = (ids: string[]): string[] => ids.filter((i) => i !== RUN_SETUPS_ITEM && i !== RUN_SETUP_WARNINGS_ITEM);
        const blockedBy = others(gate.blocking);
        const warnedBy = others(gate.acknowledgeable);
        line = {
          t: "validate",
          setupLineageId: slot.setupLineageId,
          setupDocId: slot.current.id,
          at,
          by,
          consumed: row.consumed,
          outcome: !gatesPassed || blockedBy.length > 0 ? "fail" : row.warnings.length > 0 || warnedBy.length > 0 ? "warn" : "pass",
          basisLabel: row.basisLabel,
          basisByScenario: row.basisByScenario,
          skippedFamilies: row.skippedFamilies,
          reports: {
            type: row.gates.type,
            routing: row.gates.routing,
            warnings: row.warnings,
            notImplemented: row.notImplemented,
            readiness: { blocking: blockedBy, acknowledgeable: warnedBy },
          },
        };
        extra = { compiledChain: row.planDocument.stages, planId: row.planId };
      } catch (err) {
        // A pin or state conflict, or a server fault, is the request's answer; a compile refusal is a failed validation.
        const h = toHttpError(err);
        if (h.status !== 422) throw h;
        let chain: unknown[] = [];
        let consumed: ConsumedPins = {};
        try {
          const assembled = assembleSetupPlan(ctx, head, slot, setup, null, PENDING_PLAN_ID);
          chain = assembled.plan.stages;
          consumed = assembled.consumed;
        } catch {
          // The roles themselves do not resolve; the refusal above names why.
        }
        line = {
          t: "validate",
          setupLineageId: slot.setupLineageId,
          setupDocId: slot.current.id,
          at,
          by,
          consumed,
          outcome: "fail",
          basisLabel: "",
          basisByScenario: {},
          skippedFamilies: [],
          reports: { error: errorValue(h) },
        };
        extra = { compiledChain: chain, planId: null };
      }
      wsStore.appendSetupEvent(id, line);
      const { outcome, basisLabel, basisByScenario, skippedFamilies, reports, consumed } = line;
      return { kind: "json", value: { outcome, basisLabel, basisByScenario, skippedFamilies, reports, ...extra, consumed } };
    });
  });

  // GET /api/workspaces/:id/setups/:lineageId/validations: the slot's stored validate lines, newest first, the last
  // 20. Read-only. `current` is true while the slot still pins the document that was validated. The per-run
  // fields (reports, consumed, basisByScenario) stay in the validate reply and are not served here; a failed
  // line's `reason` is derived from its stored reports at read time, so older lines carry one too.
  router.add("GET", "/api/workspaces/:id/setups/:lineageId/validations", (req) => {
    const id = req.params.id ?? "";
    const lineageId = req.params.lineageId ?? "";
    const head = wsStore.head(id);
    const slot = slotOf(head, lineageId);
    const validations = wsStore
      .readSetupEvents(id)
      .flatMap((e) => (e.t === "validate" && e.setupLineageId === lineageId ? [e] : []))
      .slice(-VALIDATION_HISTORY_LIMIT)
      .reverse()
      .map((e) => {
        const reason = storedValidationReason(e.reports);
        return {
          at: e.at,
          by: e.by,
          setupDocId: e.setupDocId,
          outcome: e.outcome,
          basisLabel: e.basisLabel,
          skippedFamilies: e.skippedFamilies,
          current: e.setupDocId === slot.current.id,
          ...(reason !== undefined ? { reason } : {}),
        };
      });
    return { kind: "json", value: { validations } };
  });

  router.add("POST", "/api/workspaces/:id/setups/:lineageId/launch", (req) => {
    const id = req.params.id ?? "";
    const lineageId = req.params.lineageId ?? "";
    const body = bodyOf(req.json());
    const by = requireBy(body);
    const ackRaw = body.acknowledge ?? [];
    if (!Array.isArray(ackRaw) || ackRaw.some((a) => typeof a !== "string")) {
      throw unprocessable(`"acknowledge" must be an array of readiness item ids, for example ["${RUN_SETUPS_ITEM}"]`, { field: "acknowledge" });
    }
    const acknowledge = ackRaw as string[];
    if (body.batch !== undefined && typeof body.batch !== "boolean") throw unprocessable(`"batch" must be a boolean`, { field: "batch" });
    const batch = body.batch === true;
    const seam = parseSeam(body.testSeam);
    if (body.mode !== undefined && body.mode !== "deterministic" && body.mode !== "stochastic") {
      throw unprocessable(`"mode" must be "deterministic" or "stochastic", got ${JSON.stringify(body.mode)}`, { field: "mode" });
    }
    if (body.mode === "stochastic") {
      if (batch) throw unprocessable("a stochastic launch runs the setup's one stochastic choice; launch it without \"batch\"", { field: "batch" });
      return launchStochastic(ctx, id, lineageId, by, acknowledge);
    }

    return wsStore.withLock([id], (): RouteResult => {
      const head = wsStore.head(id);
      assertWritable(head);
      wsStore.assertNoPendingLock(id);
      const slot = slotOf(head, lineageId);
      const setup = readSetup(ctx, slot);
      const specs: Array<{ label: string; row: SetupRow | null }> = batch
        ? setup.batch.map((r) => ({ label: r.label, row: r }))
        : [{ label: setup.name, row: null }];
      if (specs.length === 0) throw unprocessable(`run setup "${setup.id}" has no batch rows; launch it without "batch"`, { field: "batch" });

      // 1. Compile every row; nothing is written until every row passes.
      const outcomes: RowOutcome[] = specs.map(({ label, row }) => {
        try {
          const compiled = compileSetupRow(ctx, wsStore, head, slot, setup, row);
          assertOneBaseScenario(compiled.planId, compiled.request.scenarios);
          return { label, outcome: "pass", compiled };
        } catch (err) {
          const h = toHttpError(err);
          if (!batch || h.status >= 500) throw h;
          return { label, outcome: "fail", error: h };
        }
      });
      const failedRows = outcomes.filter((o) => o.outcome === "fail");
      if (failedRows.length > 0) {
        return {
          kind: "json",
          status: 422,
          value: {
            error: { code: "validation", message: `batch row(s) ${failedRows.map((o) => `"${o.label}"`).join(", ")} failed to compile; nothing was submitted` },
            rows: outcomes.map(rowReport),
          },
        };
      }
      const rows = outcomes.map((o) => (o as Extract<RowOutcome, { outcome: "pass" }>).compiled);

      // 2. The launch gate: the shared readiness report's `launchable` list for this slot, plus the
      // compile's own warnings (a setup never validated still carries them) under "run/setups".
      const events = wsStore.readSetupEvents(id);
      const readiness = computeReadinessDetail(head, ctx, wsStore);
      const entry = readiness.report.launchable[slot.setupLineageId]!;
      const blocking = [...entry.blocking];
      const acknowledgeable = [...entry.acknowledgeable];
      const reasonOf = readiness.reasonById[slot.setupLineageId] ?? {};
      const reasons: string[] = [];
      const warnings = [...new Set(rows.flatMap((r) => r.warnings))];
      if (warnings.length > 0) {
        reasons.push(`the setup carries ${warnings.length} warning(s): ${warnings.join(" ")}`);
        if (!acknowledgeable.includes(RUN_SETUP_WARNINGS_ITEM)) acknowledgeable.push(RUN_SETUP_WARNINGS_ITEM);
      }
      const staleRoles = readiness.staleBySlot[slot.setupLineageId] ?? [];
      if (staleRoles.length > 0) {
        reasons.push(
          `the newest validation consumed pins the workspace no longer holds in that role (${staleRoles.map((s) => s.role).join(", ")})` +
            (head.type === "production" ? "; a Production workspace launches only on current pins, so validate the setup again" : ""),
        );
      }
      for (const itemId of [...blocking, ...acknowledgeable]) {
        const why = reasonOf[itemId];
        // The setup's staleness and its warnings are already said above, in full.
        const saidAbove = (itemId === RUN_SETUPS_ITEM && staleRoles.length > 0) || (itemId === RUN_SETUP_WARNINGS_ITEM && warnings.length > 0);
        if (why !== undefined && !saidAbove) reasons.push(`${itemId}: ${why}`);
      }
      const unacknowledged = acknowledgeable.filter((a) => !acknowledge.includes(a));
      if (blocking.length > 0 || unacknowledged.length > 0) {
        const message =
          blocking.length > 0
            ? `launch blocked by ${blocking.join(", ")}: ${reasons.join("; ")}`
            : `launch needs acknowledge: [${unacknowledged.map((a) => `"${a}"`).join(", ")}]: ${reasons.join("; ")}`;
        return {
          kind: "json",
          status: 409,
          value: {
            error: { code: blocking.length > 0 ? "launch-blocked" : "acknowledge-required", message },
            blocking,
            acknowledgeable,
            staleRoles,
          },
        };
      }

      // 3. The counter and the launch line.
      const launchNo = events.filter((e) => e.t === "launch" && e.setupLineageId === slot.setupLineageId).length + 1;
      const consumedAll: ConsumedPins = {};
      for (const r of rows) Object.assign(consumedAll, r.consumed);
      wsStore.appendSetupEvent(id, {
        t: "launch",
        setupLineageId: slot.setupLineageId,
        setupDocId: setup.id,
        at: new Date().toISOString(),
        by,
        consumed: consumedAll,
        launchNo,
        acknowledged: acknowledge,
        batch,
        state: "submitting",
      });

      // 4. Submit in row order; the first refusal stops the batch.
      const runIds: string[] = [];
      const failed: Array<{ row: string; status: number; message: string }> = [];
      let firstRefusal: HttpError | null = null;
      for (const [i, row] of rows.entries()) {
        const label = specs[i]!.label;
        try {
          const plan = row.planDocument;
          const slateId = writeOrReuseLaunchSlate(store, row.planId, row.request.scenarios);
          const slateMeta = store.getMeta("scenario-slates", slateId);
          const consumed: ConsumedPins = {
            ...row.consumed,
            slate: { collection: "scenario-slates", id: slateId, contentHash: slateMeta.contentHash, pinnedAt: new Date().toISOString() },
          };
          const submitted = withSeam(ctx, seam, i, () =>
            submitRun(
              ctx,
              {
                portfolioId: plan.inputs.positionBook,
                marketId: plan.inputs.marketSnapshot,
                scenarioSlateId: slateId,
                assumptionSetIds: plan.inputs.assumptionSets,
                gridHorizonMonths: plan.grid.horizonMonths,
                // The seed the compile stamped ("platform-0"), so the run's request matches the compiled one.
                seed: row.request.seed,
                // Review M4 and spec E1 to E5: the compile's engine options (key rate, channels, discount basis,
                // deposit convention, SEG, liquidity stress), each sent only when it is not the default.
                engineOptions: row.engineOptions,
                // Spec E6: the setup's per-position results switch, sent only when it is on.
                ...(row.instrumentResults !== undefined ? { instrumentResults: row.instrumentResults } : {}),
                label: `${setup.name} #${launchNo}${batch ? ` / ${label}` : ""}`,
                plan: row.request.plan!,
                planTags: row.notImplemented,
                planRunLog: row.runLog,
                profileHash: row.profileHash,
                profile: row.profile,
                planDocument: plan,
                workspace: { workspaceId: id, setupLineageId: slot.setupLineageId, setupDocId: setup.id, launchNo, consumed },
              },
              row.request.views,
            ),
          );
          const runId = (submitted as { value: { runId: string } }).value.runId;
          const attachment: RunAttachment = {
            runId,
            attachedBy: "launch",
            at: new Date().toISOString(),
            setupLineageId: slot.setupLineageId,
            launchNo,
            pins: "consumed",
          };
          wsStore.appendRunAttachment(id, attachment);
          runIds.push(runId);
        } catch (err) {
          const h = toHttpError(err);
          firstRefusal = h;
          failed.push({ row: label, status: h.status, message: h.message });
          break;
        }
      }

      // 5. The completion line and the reply.
      const complete: Extract<SetupEvent, { t: "launch-complete" }> = {
        t: "launch-complete",
        setupLineageId: slot.setupLineageId,
        launchNo,
        at: new Date().toISOString(),
        runIds,
        failed,
      };
      wsStore.appendSetupEvent(id, complete);
      if (firstRefusal === null) return { kind: "json", status: 200, value: complete };
      if (runIds.length === 0) return { kind: "json", status: firstRefusal.status, value: { error: errorValue(firstRefusal), ...complete } };
      return {
        kind: "json",
        status: 207,
        value: { ...complete, cancel: runIds.map((runId) => ({ runId, method: "POST", path: `/api/runs/${runId}/cancel` })) },
      };
    });
  });
}

/**
 * @alm/reader: the pure read layer over the platform API, shared by the viewer
 * (audit workbench) and Studio. Fetch, parse, format, shape rows. Never rounds,
 * sums or re-derives a number (the client's honesty rules, unchanged by the move
 * from apps/viewer/src on 2026-09-23, Studio S1 Task 2).
 */
export * from "./api/client";
export * from "./api/workspaces";
export * from "./api/indexHistories";
export * from "./api/catalog";
export * from "./api/guided";
export * from "./api/sse";
export * from "./format";
export * from "./types";
export * from "./scenarioLabels";
export * from "./eveRows";
export * from "./rateChartRows";
export * from "./customMetricRows";
export * from "./drillLegs";
export * from "./ftpBridge";
export * from "./volSurfaceGrid";
export * from "./planDiff";
export * from "./headlines";
export * from "./niiRows";
export * from "./stack";
export * from "./workbookDate";

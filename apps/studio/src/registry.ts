// apps/studio/src/registry.ts
/**
 * The Studio's extension registry. Core code names its own screens, Results tabs, Dashboard cards and
 * Home cards; a pack loaded at startup (src/companion.ts, the one import point) adds its own here. Every read below
 * returns the core set alone when nothing is registered, and nothing here names a pack.
 *
 *   screens       a screen in one of the seven sections, placed after a named screen of that section in the rail;
 *                 it renders a page of its own, or, in Results, a registered Results tab inside the results frame
 *   result tabs   a Results tab body, by tab id
 *   headlines     a card the Dashboard shows above its own, for a run it recognises (null otherwise)
 *   home cards    a card Workspace Home shows above the workspace list (null when it has nothing to say)
 *   record slots  run setup slots whose runs are the record: the result picker defaults to their newest done run
 *   start choices a choice on the first screen beside the core two
 *   survival-path presets Studio slice S3d-1: stated or built paths and their reference checks, offered
 *                 by the survival path's calculator on Results, Liquidity beside the run's own path
 */
import type { ReactNode } from "react";
import type { BookPathInput, BookPathResult, CommitmentDials, CommitmentDialsResult, RunResult } from "@alm/engine";
import type { RunDetail, WorkspaceManifest } from "@alm/reader";
import type { TabProps } from "./pages/results/common";
// A cycle with router.ts that is safe: neither module reads the other at load, only inside functions called later.
import { SCREENS } from "./router";

/** The sections, restated (router.ts owns the list; a type import there would make a cycle at the type level only). */
export type RegistrySectionId = "workspace" | "market" | "balance" | "assumptions" | "run" | "results" | "govern";

export interface ScreenContext {
  ws: string;
  head: WorkspaceManifest | null;
  query: Record<string, string>;
}

export interface RegisteredScreen {
  section: RegistrySectionId;
  screen: string;
  label: string;
  /** The screen of the same section this one follows in the rail; absent, or not found, appends it. */
  after?: string;
  /** A Results screen: the id of the registered Results tab it shows inside the results frame. */
  resultsTab?: string;
  /** Any other screen: its page. */
  page?: (ctx: ScreenContext) => ReactNode;
}

export interface RegisteredTab {
  id: string;
  body: (p: TabProps) => ReactNode;
}

export interface RegisteredHeadline {
  id: string;
  render: (p: { result: RunResult; detail: RunDetail }) => ReactNode;
}

export interface RegisteredHomeCard {
  id: string;
  render: (p: { workspaces: WorkspaceManifest[] }) => ReactNode;
}

/**
 * A choice on the first screen, beside the core two ("Start a new analysis",
 * "Explore the example bank"). `render` draws the choice's action: a link or a button, or a sentence when the store
 * holds nothing it can open.
 */
export interface RegisteredStartChoice {
  id: string;
  title: string;
  description: string;
  render: (p: { workspaces: WorkspaceManifest[] }) => ReactNode;
}

export interface RegisteredRecordSlot {
  /** The run setup lineage id whose done runs are the record. */
  slot: string;
  /** The chip's tooltip on a run launched from the slot. */
  title: string;
}

/** One case of a survival-path preset group: an engine input the calculator opens on. */
export interface SurvivalPathPresetCase {
  id: string;
  label: string;
  input: BookPathInput;
}

export interface SurvivalPathPresetGroup {
  id: string;
  label: string;
  /** What the group reproduces, in one or two plain sentences. */
  note: string;
  cases: SurvivalPathPresetCase[];
}

/** One reference check the calculator prints beside its figure: the figure, the reference, and the verdict. */
export interface ReferenceCheck {
  label: string;
  /** The calculator's figure, already formatted. */
  studio: string;
  reference: string;
  unit: string;
  /** Where the reference comes from. */
  source: string;
  pass: boolean;
}

/**
 * Presets for the survival path's calculator, loaded on demand (a store may not hold them), with the checks a
 * case's result and the dials' result are read against. The calculator reads no run while a preset is picked.
 */
export interface RegisteredSurvivalPathPresets {
  id: string;
  /** The heading of these presets in the path picker. */
  label: string;
  load: () => Promise<{ groups: SurvivalPathPresetGroup[]; dials?: CommitmentDials }>;
  checksTitle: string;
  checks: (groupId: string, caseId: string, result: BookPathResult) => ReferenceCheck[];
  dialsChecksTitle?: string;
  dialsChecks?: (result: CommitmentDialsResult) => ReferenceCheck[];
  /** A line the calculator prints under the dials while a preset is picked. */
  dialsNote?: string;
}

/** The core Results tab ids (pages/results/tabs.tsx TAB_ORDER), restated so this module does not load the tab bodies. */
const CORE_TAB_IDS = new Set(["overview", "nii", "eve", "gap", "ftp", "seg", "liquidity", "instruments", "attribution", "lenses", "rates", "views", "metrics"]);

const screens: RegisteredScreen[] = [];
const tabs = new Map<string, RegisteredTab>();
const headlines: RegisteredHeadline[] = [];
const homeCards: RegisteredHomeCard[] = [];
const recordSlots = new Map<string, RegisteredRecordSlot>();
const startChoices: RegisteredStartChoice[] = [];
const survivalPresets: RegisteredSurvivalPathPresets[] = [];

function once<T>(list: readonly T[], has: (x: T) => boolean, what: string): void {
  if (list.some(has)) throw new Error(`${what} is already registered`);
}

export function registerScreen(s: RegisteredScreen): void {
  if (SCREENS.some((x) => x.section === s.section && x.screen === s.screen)) throw new Error(`screen ${s.section}/${s.screen} is a core screen; a pack screen needs its own id`);
  once(screens, (x) => x.section === s.section && x.screen === s.screen, `screen ${s.section}/${s.screen}`);
  if ((s.resultsTab === undefined) === (s.page === undefined)) throw new Error(`screen ${s.section}/${s.screen} needs exactly one of resultsTab and page`);
  screens.push(s);
}
export function registerResultTab(t: RegisteredTab): void {
  if (tabs.has(t.id)) throw new Error(`result tab ${t.id} is already registered`);
  if (CORE_TAB_IDS.has(t.id)) throw new Error(`result tab ${t.id} is a core tab; a pack tab needs its own id`);
  tabs.set(t.id, t);
}
export function registerHeadline(h: RegisteredHeadline): void {
  once(headlines, (x) => x.id === h.id, `headline ${h.id}`);
  headlines.push(h);
}
export function registerHomeCard(c: RegisteredHomeCard): void {
  once(homeCards, (x) => x.id === c.id, `home card ${c.id}`);
  homeCards.push(c);
}
export function registerStartChoice(c: RegisteredStartChoice): void {
  once(startChoices, (x) => x.id === c.id, `start choice ${c.id}`);
  startChoices.push(c);
}
export function registerRecordSlot(r: RegisteredRecordSlot): void {
  if (recordSlots.has(r.slot)) throw new Error(`record slot ${r.slot} is already registered`);
  recordSlots.set(r.slot, r);
}

export function registerSurvivalPathPresets(p: RegisteredSurvivalPathPresets): void {
  once(survivalPresets, (x) => x.id === p.id, `survival-path presets ${p.id}`);
  survivalPresets.push(p);
}

export const registeredScreens = (): readonly RegisteredScreen[] => screens;
export const registeredSurvivalPathPresets = (): readonly RegisteredSurvivalPathPresets[] => survivalPresets;
export const registeredScreen = (section: string, screen: string): RegisteredScreen | undefined =>
  screens.find((s) => s.section === section && s.screen === screen);
export const registeredTab = (id: string): RegisteredTab | undefined => tabs.get(id);
export const registeredHeadlines = (): readonly RegisteredHeadline[] => headlines;
export const registeredHomeCards = (): readonly RegisteredHomeCard[] => homeCards;
export const registeredStartChoices = (): readonly RegisteredStartChoice[] => startChoices;
export const recordSlot = (slot: string | null): RegisteredRecordSlot | undefined => (slot === null ? undefined : recordSlots.get(slot));

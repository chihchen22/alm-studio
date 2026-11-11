// apps/studio/src/guided/startHereEdit.ts
/**
 * Studio slice S3f fix round (H1): a Start here change made in an assumption set. The set editor never edits a set in
 * place: Save stores a copy under a new id. "Use this copy" then does what a learner would do by hand on two more
 * screens: attach the copy to the workspace's assumptions (when it is not there yet), and save the demo's setup as a new
 * version that names the copy, so Run setups opens ready to launch. Nothing is written before the learner presses it.
 */
import { getRunSetup, getWorkspace, saveRunSetup, setBlock } from "@alm/reader";
import { hrefFor } from "../router";
import { editHref } from "../assumptions/setEditModel";
import { slotOf, startHereItem, type StartHereItem } from "./startHere";

/** The Start here item an address names (`?demo=<id>`) when the item's change is made in an assumption set. */
export function editItemOf(query: Record<string, string>): (StartHereItem & { edit: { setId: string } }) | null {
  const item = query.demo === undefined ? undefined : startHereItem(query.demo);
  return item?.edit === undefined ? null : (item as StartHereItem & { edit: { setId: string } });
}

/** The set editor on the item's set, with the item in the address. */
export function editSetHref(ws: string, item: StartHereItem & { edit: { setId: string } }): string {
  return editHref(ws, { demo: item.id }, item.edit.setId);
}

/** Run setups on the demo's slot, with the item in the address. */
export function demoSetupHref(ws: string, item: StartHereItem): string {
  return hrefFor({ ws, section: "run", screen: "setups", slot: slotOf(item.id), query: { demo: item.id } });
}

/** The reader calls "Use this copy" makes; a test hands in its own. */
export const EDIT_API = { getWorkspace, setBlock, getRunSetup, saveRunSetup };
export type EditApi = typeof EDIT_API;

/**
 * Put a saved copy into the demo's setup: attach it to the workspace's assumptions unless it is there, then save the
 * slot's setup as a new version naming the copy as its only set. Returns the Run setups address of the slot.
 */
export async function putCopyInDemo(p: { ws: string; item: StartHereItem; copyId: string; by: string }, api: EditApi = EDIT_API): Promise<string> {
  let head = await api.getWorkspace(p.ws);
  const slot = head.blocks.run.setups.find((s) => s.setupLineageId === slotOf(p.item.id));
  if (slot === undefined) throw new Error(`This workspace has no setup for ${p.item.title} yet. Open the step from Start here first.`);
  if (!head.blocks.assumptions.sets.some((s) => s.id === p.copyId)) {
    head = await api.setBlock(p.ws, { expectedRevision: head.revision, by: p.by, block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: p.copyId } });
  }
  const { id: _id, ...setup } = await api.getRunSetup(slot.current.id);
  const next = { ...setup, inputs: { ...setup.inputs, assumptionSetIds: [p.copyId] } };
  await api.saveRunSetup({ workspaceId: p.ws, setupLineageId: slot.setupLineageId, expectedRevision: head.revision, by: p.by, setup: next });
  return demoSetupHref(p.ws, p.item);
}

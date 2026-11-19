"use server";

import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { boundValues, handleFormAction as submit } from "@/lib/form-actions";
import type { FormState } from "@/lib/form-state";
import {
  acceptTagProposal,
  createCluster,
  createDocumentType,
  createTag,
  createTopicArea,
  deleteCluster,
  descriptionSchema,
  nameSchema,
  rejectTagProposal,
  renameCluster,
  setDocumentTypeActive,
  setTagActive,
  setTopicAreaActive,
  updateDocumentType,
  updateTag,
  updateTopicArea,
} from "@/lib/library/taxonomy";

/* The taxonomy page. Every command checks that the actor is a maintainer. */

const PAGE = "/maintenance/taxonomy";
const noFields = z.object({});
const nameOnly = z.object({ name: nameSchema });
const entrySchema = z.object({ name: nameSchema, description: descriptionSchema });
const clusterId = z.preprocess((value) => (value === "" ? null : value), z.uuid().nullable());
const tagSchema = z.object({ name: nameSchema, description: descriptionSchema, clusterId });

export async function createClusterAction(_state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, nameOnly, async (actor, input) => {
    await createCluster(getDb(), actor, input.name);
    return PAGE;
  });
}

export async function renameClusterAction(id: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, nameOnly, async (actor, input) => {
    await renameCluster(getDb(), actor, id, input.name);
    return PAGE;
  }, boundValues.id.safeParse([id]));
}

export async function deleteClusterAction(id: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noFields, async (actor) => {
    await deleteCluster(getDb(), actor, id);
    return PAGE;
  }, boundValues.id.safeParse([id]));
}

export async function createTagAction(_state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, tagSchema, async (actor, input) => {
    await createTag(getDb(), actor, input);
    return PAGE;
  });
}

export async function updateTagAction(tagId: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, tagSchema, async (actor, input) => {
    await updateTag(getDb(), actor, tagId, input);
    return PAGE;
  }, boundValues.id.safeParse([tagId]));
}

export async function setTagActiveAction(tagId: string, isActive: boolean, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noFields, async (actor) => {
    await setTagActive(getDb(), actor, tagId, isActive);
    return PAGE;
  }, boundValues.idAndFlag.safeParse([tagId, isActive]));
}

export async function createDocumentTypeAction(_state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, entrySchema, async (actor, input) => {
    await createDocumentType(getDb(), actor, input);
    return PAGE;
  });
}

export async function updateDocumentTypeAction(id: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, entrySchema, async (actor, input) => {
    await updateDocumentType(getDb(), actor, id, input);
    return PAGE;
  }, boundValues.id.safeParse([id]));
}

export async function setDocumentTypeActiveAction(id: string, isActive: boolean, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noFields, async (actor) => {
    await setDocumentTypeActive(getDb(), actor, id, isActive);
    return PAGE;
  }, boundValues.idAndFlag.safeParse([id, isActive]));
}

export async function createTopicAreaAction(_state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, entrySchema, async (actor, input) => {
    await createTopicArea(getDb(), actor, input);
    return PAGE;
  });
}

export async function updateTopicAreaAction(id: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, entrySchema, async (actor, input) => {
    await updateTopicArea(getDb(), actor, id, input);
    return PAGE;
  }, boundValues.id.safeParse([id]));
}

export async function setTopicAreaActiveAction(id: string, isActive: boolean, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noFields, async (actor) => {
    await setTopicAreaActive(getDb(), actor, id, isActive);
    return PAGE;
  }, boundValues.idAndFlag.safeParse([id, isActive]));
}

const acceptSchema = z.union([
  z.object({ existingTagId: z.uuid("Choose a tag.") }),
  z.object({ existingTagId: z.literal("").optional(), name: nameSchema, clusterId, description: descriptionSchema }),
]);

export async function acceptTagProposalAction(proposalId: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, acceptSchema, async (actor, input) => {
    await acceptTagProposal(
      getDb(),
      actor,
      proposalId,
      "name" in input ? { name: input.name, clusterId: input.clusterId, description: input.description } : { existingTagId: input.existingTagId },
    );
    return PAGE;
  }, boundValues.id.safeParse([proposalId]));
}

export async function rejectTagProposalAction(proposalId: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noFields, async (actor) => {
    await rejectTagProposal(getDb(), actor, proposalId);
    return PAGE;
  }, boundValues.id.safeParse([proposalId]));
}

"use server";

import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { boundValues, handleFormAction as submit } from "@/lib/form-actions";
import type { FormState } from "@/lib/form-state";
import { deleteSubmission, releaseSubmission, retrySubmission } from "@/lib/library/review";
import { getStorage } from "@/lib/storage";

/* Uploads on hold. The commands check that the actor is a steward. */

const noFields = z.object({});

export async function releaseSubmissionAction(id: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noFields, async (actor) => {
    await releaseSubmission(getDb(), actor, id);
    return "/steward";
  }, boundValues.id.safeParse([id]));
}

export async function retrySubmissionAction(id: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noFields, async (actor) => {
    await retrySubmission(getDb(), actor, id);
    return "/steward";
  }, boundValues.id.safeParse([id]));
}

export async function deleteSubmissionAction(id: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noFields, async (actor) => {
    await deleteSubmission(getDb(), getStorage(), actor, id);
    return "/steward";
  }, boundValues.id.safeParse([id]));
}

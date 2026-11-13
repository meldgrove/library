"use server";

import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { savePreferences } from "@/lib/directory/manage";
import { preferencesSchema } from "@/lib/directory/schemas";
import { handleFormAction as submit } from "@/lib/form-actions";
import type { FormState } from "@/lib/form-state";
import { saveTagSubscriptions } from "@/lib/library/subscriptions";

/** Saves the signed-in person's time zone and date format. */
export async function savePreferencesAction(_state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, preferencesSchema, async (actor, input) => {
    await savePreferences(getDb(), actor.personId, input);
    return "/settings";
  });
}

const subscriptionsSchema = z.object({
  // A single checked box arrives as a string, none as nothing.
  tagIds: z.preprocess((value) => (typeof value === "string" ? [value] : (value ?? [])), z.array(z.uuid({ error: "Choose tags from the list." }))),
});

/** Saves the tags the signed-in person follows for their weekly email. */
export async function saveTagSubscriptionsAction(_state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, subscriptionsSchema, async (actor, input) => {
    await saveTagSubscriptions(getDb(), actor.personId, input.tagIds);
    return "/settings";
  });
}

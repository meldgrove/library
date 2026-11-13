"use server";

import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { boundValues, handleFormAction as submit } from "@/lib/form-actions";
import type { FormState } from "@/lib/form-state";
import { notePath } from "@/lib/library/constants";
import { noteFormSchema } from "@/lib/library/note-input";
import { checkNote, deleteNote, discardNote, saveNote } from "@/lib/library/review";
import { getStorage } from "@/lib/storage";

/* A note's review and the steward's actions on it. The commands check who may act. */

const noFields = z.object({});
const deleteSchema = z.object({ reason: z.string().trim().min(3, "Say why the note is deleted.").max(300, "At most 300 characters.") });

export async function saveNoteAction(noteId: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noteFormSchema, async (actor, input) => {
    const { number } = await saveNote(getDb(), actor, noteId, input);
    return notePath(number);
  }, boundValues.id.safeParse([noteId]));
}

export async function discardNoteAction(noteId: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noFields, async (actor) => {
    await discardNote(getDb(), actor, noteId);
    return "/review";
  }, boundValues.id.safeParse([noteId]));
}

export async function deleteNoteAction(noteId: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, deleteSchema, async (actor, input) => {
    await deleteNote(getDb(), getStorage(), actor, noteId, input.reason);
    return "/";
  }, boundValues.id.safeParse([noteId]));
}

export async function checkNoteAction(noteId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noFields, async (actor) => {
    await checkNote(getDb(), actor, noteId);
    return notePath(number);
  }, z.tuple([z.uuid(), z.number().int().positive()]).safeParse([noteId, number]));
}

"use client";

import { useId } from "react";
import { useFormAction } from "@/components/form/use-form-action";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/form-state";

/** Deletes a note with a reason, e.g. a copyright or privacy request. */
export function DeleteNoteForm({ action }: { action: (state: FormState, formData: FormData) => Promise<FormState> }) {
  const { state, onSubmit, pending } = useFormAction(action);
  const id = useId();
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <Field data-invalid={state.fieldErrors?.reason ? true : undefined}>
        <FieldLabel htmlFor={`${id}-reason`}>Why delete it?</FieldLabel>
        <Textarea id={`${id}-reason`} name="reason" rows={2} maxLength={300} required />
        <FieldDescription>
          The note, its original, and every upload of it are deleted, also from connected tools. This cannot be undone.
        </FieldDescription>
        <FieldError>{state.fieldErrors?.reason ?? state.formError}</FieldError>
      </Field>
      <Button type="submit" variant="destructive" disabled={pending} className="self-start">
        Delete note
      </Button>
    </form>
  );
}

"use client";

import { useId } from "react";
import { FormError } from "@/components/form/field";
import { useFormAction } from "@/components/form/use-form-action";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import type { FormState } from "@/lib/form-state";

interface SubscriptionsFormProps {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  tagGroups: { cluster: string; tags: { id: string; name: string }[] }[];
  followed: string[];
}

/** The tags a person follows for their weekly email. */
export function SubscriptionsForm({ action, tagGroups, followed }: SubscriptionsFormProps) {
  const { state, onSubmit, pending } = useFormAction(action);
  const id = useId();
  const error = state.fieldErrors?.tagIds;
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <FormError message={state.formError} />
      <FieldSet data-invalid={error ? true : undefined}>
        <FieldLegend variant="label">Tags you follow</FieldLegend>
        <FieldDescription>
          Every Monday, the library emails you the notes others published in the past week that carry one of these tags and that you may see. Without tags,
          or without new notes, you get no email.
        </FieldDescription>
        {tagGroups.length === 0 ? <p className="text-sm text-muted-foreground">The taxonomy has no tags yet.</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          {tagGroups.map((group) => (
            <div key={group.cluster} className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">{group.cluster}</p>
              {group.tags.map((t) => (
                <Field key={t.id} orientation="horizontal">
                  <Checkbox id={`${id}-tag-${t.id}`} name="tagIds" value={t.id} defaultChecked={followed.includes(t.id)} />
                  <FieldLabel htmlFor={`${id}-tag-${t.id}`} className="font-normal">
                    {t.name}
                  </FieldLabel>
                </Field>
              ))}
            </div>
          ))}
        </div>
        <FieldError>{error}</FieldError>
      </FieldSet>
      <Button type="submit" disabled={pending} className="self-start">
        Save tags
      </Button>
    </form>
  );
}

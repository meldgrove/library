"use client";

import { useEffect, useRef } from "react";
import type { FormState } from "@/lib/form-state";
import { useFormAction } from "@/components/form/use-form-action";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
/** Longest name of a tag, team, document type, or project. */
export const NAME_MAX = 80;

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

/** One-line name form, used to create and to rename a tag, a team, or a list entry. */
export function NameForm({
  action,
  id,
  label,
  defaultValue,
  submitLabel,
  clearOnSuccess = false,
  maxLength = NAME_MAX,
}: {
  action: Action;
  id: string;
  label: string;
  defaultValue?: string;
  submitLabel: string;
  clearOnSuccess?: boolean;
  maxLength?: number;
}) {
  const { state, onSubmit, pending } = useFormAction(action);
  const form = useRef<HTMLFormElement>(null);
  const error = state.fieldErrors?.name ?? state.formError;
  useEffect(() => {
    if (clearOnSuccess && state.done) form.current?.reset();
  }, [clearOnSuccess, state]);
  return (
    <form ref={form} onSubmit={onSubmit} className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Input
          id={id}
          name="name"
          aria-label={label}
          required
          maxLength={maxLength}
          defaultValue={defaultValue}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="max-w-xs"
        />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {submitLabel}
        </Button>
      </div>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </form>
  );
}

/** Activate or deactivate button that shows why a change was refused. */
export function ActiveForm({ action, isActive }: { action: (state: FormState) => Promise<FormState>; isActive: boolean }) {
  const { state, onSubmit, pending } = useFormAction(action);
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-1">
      <Button type="submit" variant="ghost" size="sm" disabled={pending} className="self-start">
        {isActive ? "Deactivate" : "Activate"}
      </Button>
      <FieldError>{state.formError}</FieldError>
    </form>
  );
}

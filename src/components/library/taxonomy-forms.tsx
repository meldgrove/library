"use client";

import { useEffect, useId, useRef } from "react";
import { useFormAction } from "@/components/form/use-form-action";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { FormState } from "@/lib/form-state";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

interface Option {
  id: string;
  name: string;
}

/** Name, cluster, and description of a tag; creates or updates it. */
export function TagForm({
  action,
  clusters,
  defaults,
  submitLabel,
  clearOnSuccess = false,
}: {
  action: Action;
  clusters: Option[];
  defaults?: { name: string; description: string; clusterId: string | null };
  submitLabel: string;
  clearOnSuccess?: boolean;
}) {
  const { state, onSubmit, pending } = useFormAction(action);
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (clearOnSuccess && state.done) form.current?.reset();
  }, [clearOnSuccess, state]);
  return (
    <form ref={form} onSubmit={onSubmit} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Input name="name" defaultValue={defaults?.name} aria-label="Tag name" placeholder="Tag" required maxLength={80} className="w-40" aria-invalid={state.fieldErrors?.name ? true : undefined} />
        <NativeSelect name="clusterId" defaultValue={defaults?.clusterId ?? ""} aria-label="Cluster">
          <NativeSelectOption value="">No cluster</NativeSelectOption>
          {clusters.map((cluster) => (
            <NativeSelectOption key={cluster.id} value={cluster.id}>
              {cluster.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Input name="description" defaultValue={defaults?.description} aria-label="What the tag covers" placeholder="What it covers (for the AI)" maxLength={300} className="min-w-48 flex-1" id={`${id}-description`} />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {submitLabel}
        </Button>
      </div>
      <FieldError>{state.fieldErrors?.name ?? state.fieldErrors?.description ?? state.formError}</FieldError>
    </form>
  );
}

/** Accepts a proposed tag as a new tag, or maps it to an existing one. */
export function ProposalForm({ action, name, clusters, tags }: { action: Action; name: string; clusters: Option[]; tags: Option[] }) {
  const { state, onSubmit, pending } = useFormAction(action);
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect name="existingTagId" defaultValue="" aria-label={`Map ${name} to an existing tag`}>
          <NativeSelectOption value="">New tag “{name}”</NativeSelectOption>
          {tags.map((t) => (
            <NativeSelectOption key={t.id} value={t.id}>
              Use {t.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <input type="hidden" name="name" value={name} />
        <NativeSelect name="clusterId" defaultValue="" aria-label="Cluster of the new tag">
          <NativeSelectOption value="">No cluster</NativeSelectOption>
          {clusters.map((cluster) => (
            <NativeSelectOption key={cluster.id} value={cluster.id}>
              {cluster.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button type="submit" size="sm" disabled={pending}>
          Accept
        </Button>
      </div>
      <FieldError>{state.fieldErrors?.existingTagId ?? state.fieldErrors?.name ?? state.formError}</FieldError>
    </form>
  );
}

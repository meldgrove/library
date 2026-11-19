"use client";

import { Button } from "@meldgrove/ui/button";
import { FieldError } from "@meldgrove/ui/field";
import { Input } from "@meldgrove/ui/input";
import { useFormAction } from "@/components/form/use-form-action";
import type { FormState } from "@/lib/form-state";

/** The Slack channel that gets a team's weekly digest; empty for none. */
export function DigestChannelForm({
  action,
  id,
  teamName,
  defaultValue,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  id: string;
  teamName: string;
  defaultValue: string | null;
}) {
  const { state, onSubmit, pending } = useFormAction(action);
  const error = state.fieldErrors?.channelId ?? state.formError;
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Input
          id={id}
          name="channelId"
          aria-label={`Slack channel for the digest of ${teamName}`}
          placeholder="C0123456789"
          maxLength={30}
          defaultValue={defaultValue ?? ""}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="w-40 font-mono"
        />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          Save
        </Button>
      </div>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </form>
  );
}

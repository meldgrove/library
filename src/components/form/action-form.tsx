"use client";

import { Button } from "@meldgrove/ui/button";
import { FieldError } from "@meldgrove/ui/field";
import { cn } from "@meldgrove/ui/utils";
import type { ComponentProps, ReactNode } from "react";
import { useFormAction } from "@/components/form/use-form-action";
import type { FormState } from "@/lib/form-state";

interface ActionFormProps {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
  pendingLabel?: string;
  variant?: ComponentProps<typeof Button>["variant"];
  className?: string;
  children?: ReactNode;
}

/** A small form for one process step. Shows every error message above the button. */
export function ActionForm({ action, submitLabel, pendingLabel = "Saving…", variant = "default", className, children }: ActionFormProps) {
  const { state, onSubmit, pending } = useFormAction(action);
  const messages = [state.formError, ...Object.values(state.fieldErrors ?? {})].filter((m): m is string => Boolean(m));
  return (
    <form onSubmit={onSubmit} className={cn("flex flex-col gap-3", className)}>
      {children}
      <FieldError errors={messages.map((message) => ({ message }))} />
      <div>
        <Button type="submit" variant={variant} size="sm" disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}

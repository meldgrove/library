"use client";

import { useEffect, useRef } from "react";
import type { FormState } from "@/lib/form-state";
import { describedBy, Field, FormError } from "@/components/form/field";
import { useFormAction } from "@/components/form/use-form-action";
import { Button } from "@/components/ui/button";
import { FieldDescription, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ROLE_HELP, ROLE_LABELS, ROLES, type Role } from "@/lib/auth/roles";
import { PERSON_NAME_MAX } from "@/lib/directory/schemas";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;
type TeamOption = { id: string; name: string };

function TeamSelect({
  id,
  teams,
  defaultValue,
  error,
  label,
}: {
  id: string;
  teams: TeamOption[];
  defaultValue?: string | null;
  error?: string;
  /** For a select without a visible label. */
  label?: string;
}) {
  return (
    <NativeSelect
      id={id}
      name="teamId"
      defaultValue={defaultValue ?? ""}
      aria-label={label}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, error)}
      wrapperClassName="w-full"
    >
      <NativeSelectOption value="">No team</NativeSelectOption>
      {teams.map((team) => (
        <NativeSelectOption key={team.id} value={team.id}>
          {team.name}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

/** Invites a person by email. They get access at their first login with that verified email address. */
export function InvitePersonForm({ action, teams }: { action: Action; teams: TeamOption[] }) {
  const { state, onSubmit, pending } = useFormAction(action);
  const form = useRef<HTMLFormElement>(null);
  const errors = state.fieldErrors ?? {};
  useEffect(() => {
    if (state.done) form.current?.reset();
  }, [state]);
  return (
    <form ref={form} onSubmit={onSubmit} className="flex flex-col gap-4">
      <FormError message={state.formError} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="invite-email" label="Email" required error={errors.email}>
          <Input id="invite-email" name="email" type="email" required autoComplete="off" aria-invalid={errors.email ? true : undefined} aria-describedby={describedBy("invite-email", errors.email)} />
        </Field>
        <Field id="invite-name" label="Name" required error={errors.name}>
          <Input id="invite-name" name="name" required maxLength={PERSON_NAME_MAX} autoComplete="off" aria-invalid={errors.name ? true : undefined} aria-describedby={describedBy("invite-name", errors.name)} />
        </Field>
        <Field id="invite-team" label="Team" error={errors.teamId}>
          <TeamSelect id="invite-team" teams={teams} error={errors.teamId} />
        </Field>
        <Field id="invite-role" label="Role" required error={errors.role}>
          <RoleSelect id="invite-role" error={errors.role} />
        </Field>
      </div>
      <FieldDescription>{ROLE_HELP}</FieldDescription>
      <Button type="submit" disabled={pending} className="self-start">
        Invite
      </Button>
    </form>
  );
}

function RoleSelect({ id, defaultValue = "member", error, label }: { id: string; defaultValue?: Role; error?: string; label?: string }) {
  return (
    <NativeSelect
      id={id}
      name="role"
      defaultValue={defaultValue}
      aria-label={label}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, error)}
      wrapperClassName="w-full"
    >
      {ROLES.map((role) => (
        <NativeSelectOption key={role} value={role}>
          {ROLE_LABELS[role]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

/** A person's role, changed in their table row. */
export function RoleForm({ action, id, role }: { action: Action; id: string; role: Role }) {
  const { state, onSubmit, pending } = useFormAction(action);
  const error = state.fieldErrors?.role ?? state.formError;
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div className="w-36">
          <RoleSelect id={`${id}-role`} defaultValue={role} error={error} label="Role" />
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={pending} className="self-center">
          Save
        </Button>
      </div>
      {error ? <FieldError id={`${id}-role-error`}>{error}</FieldError> : null}
    </form>
  );
}

/** Name and team of a person, edited in their table row. */
export function PersonForm({ action, id, name, teamId, teams }: { action: Action; id: string; name: string; teamId: string | null; teams: TeamOption[] }) {
  const { state, onSubmit, pending } = useFormAction(action);
  const error = state.fieldErrors?.name ?? state.fieldErrors?.teamId ?? state.formError;
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        <Input id={`${id}-name`} name="name" aria-label="Name" required maxLength={PERSON_NAME_MAX} defaultValue={name} className="w-48" aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} />
        <div className="w-44">
          <TeamSelect id={`${id}-team`} teams={teams} defaultValue={teamId} label="Team" />
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={pending} className="self-center">
          Save
        </Button>
      </div>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </form>
  );
}

/** A single button that runs an action and shows why it was refused. */
export function ActionButton({ action, label, variant = "ghost" }: { action: Action; label: string; variant?: "ghost" | "outline" | "destructive" }) {
  const { state, onSubmit, pending } = useFormAction(action);
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-1">
      <Button type="submit" variant={variant} size="sm" disabled={pending} className="self-start">
        {label}
      </Button>
      <FieldError>{state.formError}</FieldError>
    </form>
  );
}

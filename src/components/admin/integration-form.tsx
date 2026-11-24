"use client";

import { Alert, AlertDescription } from "@meldgrove/ui/alert";
import { Badge } from "@meldgrove/ui/badge";
import { Button } from "@meldgrove/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@meldgrove/ui/card";
import { Input } from "@meldgrove/ui/input";
import { NativeSelect, NativeSelectOption } from "@meldgrove/ui/native-select";
import { initialSecret, SecretField, secretPayload, type SecretValue } from "@meldgrove/ui/secret-field";
import { CircleAlert, CircleCheck } from "lucide-react";
import { useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";
import { describedBy, Field, FormError } from "@/components/form/field";
import type { SettingActionResult } from "@/app/(app)/admin/integrations/actions";

/** One field of a setting, as the page describes it (`src/lib/settings/definitions.ts` holds the rules). */
export interface IntegrationField {
  name: string;
  label: string;
  kind: "secret" | "text" | "choice" | "list";
  options?: { value: string; label: string }[];
  hint?: string;
  placeholder?: string;
  /** Shown only while another field has this value, e.g. the SMTP URL for the SMTP provider. */
  showWhen?: { field: string; value: string };
  /** Marked as required while the field is shown. */
  required?: boolean;
}

export type SettingState = "set" | "not set" | "incomplete";

interface SecretViewValue {
  saved: boolean;
  hint: string | null;
}

const STATE_BADGE: Record<SettingState, { label: string; variant: "secondary" | "outline" | "destructive" }> = {
  set: { label: "Set up", variant: "secondary" },
  "not set": { label: "Off", variant: "outline" },
  incomplete: { label: "Incomplete", variant: "destructive" },
};

function initialValues(fields: IntegrationField[], view: Record<string, unknown>) {
  const values: Record<string, string> = {};
  const secrets: Record<string, SecretValue> = {};
  for (const field of fields) {
    const value = view[field.name];
    if (field.kind === "secret") secrets[field.name] = initialSecret(Boolean((value as SecretViewValue | undefined)?.saved));
    else if (field.kind === "list") values[field.name] = Array.isArray(value) ? value.join(", ") : "";
    else values[field.name] = typeof value === "string" ? value : "";
  }
  return { values, secrets };
}

/**
 * A card of Admin › Integrations: the setting's fields, Save, and the test
 * button. It sends the body that `cli settings apply <name>` reads.
 */
export function IntegrationForm({
  name,
  title,
  description,
  fields,
  initialView,
  save,
  test,
  testAddress,
  notices = [],
}: {
  name: string;
  title: string;
  description: string;
  fields: IntegrationField[];
  initialView: Record<string, unknown>;
  save: (name: string, body: Record<string, unknown>) => Promise<SettingActionResult>;
  test?: (name: string, options: { to?: string }) => Promise<SettingActionResult>;
  /** Email: where the test email goes by default (the admin's own address). */
  testAddress?: string;
  notices?: string[];
}) {
  const [view, setView] = useState(initialView);
  const [{ values, secrets }, setForm] = useState(() => initialValues(fields, initialView));
  const [result, setResult] = useState<SettingActionResult>({ ok: true });
  const [testResult, setTestResult] = useState<SettingActionResult | null>(null);
  const [to, setTo] = useState(testAddress ?? "");
  const [saving, startSaving] = useTransition();
  const [testing, startTesting] = useTransition();
  const state = (view.state as SettingState | undefined) ?? "not set";

  const shown = (field: IntegrationField) => !field.showWhen || values[field.showWhen.field] === field.showWhen.value;
  const setValue = (field: string, value: string) => setForm((form) => ({ ...form, values: { ...form.values, [field]: value } }));
  const setSecret = (field: string, value: SecretValue) => setForm((form) => ({ ...form, secrets: { ...form.secrets, [field]: value } }));

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body: Record<string, unknown> = {};
    for (const field of fields) {
      if (!shown(field)) continue;
      if (field.kind === "secret") {
        const payload = secretPayload(secrets[field.name]!);
        if (payload !== undefined) body[field.name] = payload;
      } else if (field.kind === "list") {
        body[field.name] = values[field.name]!.split(/[\s,;]+/).filter(Boolean);
      } else if (field.kind === "choice") {
        body[field.name] = values[field.name] || null;
      } else {
        body[field.name] = values[field.name];
      }
    }
    startSaving(async () => {
      const saved = await save(name, body);
      setResult(saved);
      if (saved.ok && saved.view) {
        setView(saved.view);
        setForm(initialValues(fields, saved.view));
        setTestResult(null);
        toast.success(saved.message ?? "Saved.");
      }
    });
  }

  function onTest() {
    if (!test) return;
    startTesting(async () => setTestResult(await test(name, { to })));
  }

  const errors = result.fieldErrors ?? {};
  const id = (field: string) => `${name}-${field}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <h2>{title}</h2>
          <Badge variant={STATE_BADGE[state].variant}>{STATE_BADGE[state].label}</Badge>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" aria-label={title} noValidate>
          {notices.map((notice) => (
            <Alert key={notice}>
              <CircleAlert aria-hidden="true" />
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          ))}
          {!result.ok && result.message ? <FormError message={result.message} /> : null}
          {fields.filter(shown).map((field) => {
            const error = errors[field.name];
            if (field.kind === "secret") {
              const saved = view[field.name] as SecretViewValue | undefined;
              return (
                <SecretField
                  key={field.name}
                  id={id(field.name)}
                  label={field.label}
                  stored={Boolean(saved?.saved)}
                  hint={saved?.hint}
                  value={secrets[field.name]!}
                  onChange={(value) => setSecret(field.name, value)}
                  removable={!field.required}
                  placeholder={field.placeholder}
                  description={field.hint}
                  error={error}
                />
              );
            }
            return (
              <Field key={field.name} id={id(field.name)} label={field.label} required={field.required} hint={field.hint} error={error}>
                {field.kind === "choice" ? (
                  <NativeSelect
                    id={id(field.name)}
                    value={values[field.name]}
                    onChange={(event) => setValue(field.name, event.target.value)}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy(id(field.name), error, field.hint)}
                  >
                    <NativeSelectOption value="">Off</NativeSelectOption>
                    {field.options?.map((option) => (
                      <NativeSelectOption key={option.value} value={option.value}>
                        {option.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                ) : (
                  <Input
                    id={id(field.name)}
                    value={values[field.name]}
                    onChange={(event) => setValue(field.name, event.target.value)}
                    placeholder={field.placeholder}
                    autoComplete="off"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy(id(field.name), error, field.hint)}
                  />
                )}
              </Field>
            );
          })}
          <div className="flex flex-wrap items-end gap-2">
            <Button type="submit" disabled={saving}>
              Save
            </Button>
            {test ? (
              <>
                {name === "email" ? (
                  <Input
                    aria-label="Address for the test email"
                    type="email"
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                    className="w-64"
                    placeholder="name@example.org"
                  />
                ) : null}
                <Button type="button" variant="outline" onClick={onTest} disabled={testing || state !== "set"}>
                  {name === "email" ? "Send test email" : "Test"}
                </Button>
              </>
            ) : null}
          </div>
          {testResult ? (
            <Alert variant={testResult.ok ? "default" : "destructive"} role="status">
              {testResult.ok ? <CircleCheck aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
              <AlertDescription>{testResult.fieldErrors?.to ? `The address ${testResult.fieldErrors.to}.` : testResult.message}</AlertDescription>
            </Alert>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

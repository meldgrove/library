"use client";

import { TriangleAlert } from "lucide-react";
import { startTransition, useActionState, useId, useRef } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/form-state";
import { NOTE_LIMITS, VISIBILITY_LABELS, type Visibility } from "@/lib/library/constants";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

interface Option {
  id: string;
  name: string;
}

export interface NoteFormProps {
  action: Action;
  /** A draft is published from here; a published note is only saved. */
  status: "draft" | "published";
  defaults: {
    title: string;
    core: string;
    keyPoints: string;
    quotes: string;
    citation: string;
    language: string;
    documentTypeId: string;
    projectId: string;
    tagIds: string[];
    visibility: Visibility;
  };
  uncertainFields: string[];
  documentTypes: Option[];
  projects: Option[];
  tagGroups: { cluster: string; tags: Option[] }[];
  /** The owner's team, for "My team"; null when the owner has none. */
  teamName: string | null;
  visibilityDescriptions: Record<Visibility, string>;
}

function Unsure({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-amber-700 dark:text-amber-400">
      <TriangleAlert aria-hidden="true" className="size-3.5" />
      AI unsure, check
    </span>
  );
}

/** The review of a note: every field of the template, then publish or save. */
export function NoteForm({ action, status, defaults, uncertainFields, documentTypes, projects, tagGroups, teamName, visibilityDescriptions }: NoteFormProps) {
  const [state, dispatch, pending] = useActionState(action, {});
  const intent = useRef<"save" | "publish">(status === "draft" ? "publish" : "save");
  const id = useId();
  const unsure = (field: string) => uncertainFields.includes(field);
  const error = (field: string) => state.fieldErrors?.[field];

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    formData.set("intent", intent.current);
    startTransition(() => dispatch(formData));
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      {state.formError ? (
        <Alert variant="destructive">
          <AlertDescription>{state.formError}</AlertDescription>
        </Alert>
      ) : null}

      <Field data-invalid={error("title") ? true : undefined}>
        <FieldLabel htmlFor={`${id}-title`}>
          Title
          <Unsure show={unsure("title")} />
        </FieldLabel>
        <Input id={`${id}-title`} name="title" defaultValue={defaults.title} maxLength={NOTE_LIMITS.title} required />
        <FieldError>{error("title")}</FieldError>
      </Field>

      <Field data-invalid={error("core") ? true : undefined}>
        <FieldLabel htmlFor={`${id}-core`}>
          Core
          <Unsure show={unsure("core")} />
        </FieldLabel>
        <Textarea id={`${id}-core`} name="core" defaultValue={defaults.core} rows={3} maxLength={NOTE_LIMITS.core} required />
        <FieldDescription>The source in 2–3 sentences.</FieldDescription>
        <FieldError>{error("core")}</FieldError>
      </Field>

      <Field data-invalid={error("keyPoints") ? true : undefined}>
        <FieldLabel htmlFor={`${id}-key-points`}>
          Key points
          <Unsure show={unsure("keyPoints")} />
        </FieldLabel>
        <Textarea id={`${id}-key-points`} name="keyPoints" defaultValue={defaults.keyPoints} rows={6} />
        <FieldDescription>
          {NOTE_LIMITS.keyPoints.min}–{NOTE_LIMITS.keyPoints.max} points, one per line. Keep the numbers the source gives.
        </FieldDescription>
        <FieldError>{error("keyPoints")}</FieldError>
      </Field>

      <Field data-invalid={error("quotes") ? true : undefined}>
        <FieldLabel htmlFor={`${id}-quotes`}>
          Quotes
          <Unsure show={unsure("quotes")} />
        </FieldLabel>
        <Textarea id={`${id}-quotes`} name="quotes" defaultValue={defaults.quotes} rows={4} />
        <FieldDescription>Word for word from the source, one per line. Add the page after “ | ”, e.g. “… | p. 12”.</FieldDescription>
        <FieldError>{error("quotes")}</FieldError>
      </Field>

      <Field data-invalid={error("citation") ? true : undefined}>
        <FieldLabel htmlFor={`${id}-citation`}>
          Citation
          <Unsure show={unsure("citation")} />
        </FieldLabel>
        <Textarea id={`${id}-citation`} name="citation" defaultValue={defaults.citation} rows={2} maxLength={NOTE_LIMITS.citation} />
        <FieldError>{error("citation")}</FieldError>
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field data-invalid={error("documentTypeId") ? true : undefined}>
          <FieldLabel htmlFor={`${id}-type`}>
            Document type
            <Unsure show={unsure("documentType")} />
          </FieldLabel>
          <NativeSelect id={`${id}-type`} name="documentTypeId" defaultValue={defaults.documentTypeId}>
            <NativeSelectOption value="">Not set</NativeSelectOption>
            {documentTypes.map((type) => (
              <NativeSelectOption key={type.id} value={type.id}>
                {type.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldError>{error("documentTypeId")}</FieldError>
        </Field>
        <Field data-invalid={error("projectId") ? true : undefined}>
          <FieldLabel htmlFor={`${id}-project`}>
            Project
            <Unsure show={unsure("project")} />
          </FieldLabel>
          <NativeSelect id={`${id}-project`} name="projectId" defaultValue={defaults.projectId}>
            <NativeSelectOption value="">None</NativeSelectOption>
            {projects.map((p) => (
              <NativeSelectOption key={p.id} value={p.id}>
                {p.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldError>{error("projectId")}</FieldError>
        </Field>
        <Field data-invalid={error("language") ? true : undefined}>
          <FieldLabel htmlFor={`${id}-language`}>
            Language
            <Unsure show={unsure("language")} />
          </FieldLabel>
          <Input id={`${id}-language`} name="language" defaultValue={defaults.language} maxLength={2} placeholder="de" />
          <FieldError>{error("language")}</FieldError>
        </Field>
      </div>

      <FieldSet data-invalid={error("tagIds") ? true : undefined}>
        <FieldLegend variant="label">
          Tags
          <Unsure show={unsure("tags")} />
        </FieldLegend>
        <FieldDescription>
          {NOTE_LIMITS.tags.min}–{NOTE_LIMITS.tags.max} tags from the list.
        </FieldDescription>
        {tagGroups.length === 0 ? <p className="text-sm text-muted-foreground">The taxonomy has no tags yet.</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          {tagGroups.map((group) => (
            <div key={group.cluster} className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">{group.cluster}</p>
              {group.tags.map((t) => (
                <Field key={t.id} orientation="horizontal">
                  <Checkbox id={`${id}-tag-${t.id}`} name="tagIds" value={t.id} defaultChecked={defaults.tagIds.includes(t.id)} />
                  <FieldLabel htmlFor={`${id}-tag-${t.id}`} className="font-normal">
                    {t.name}
                  </FieldLabel>
                </Field>
              ))}
            </div>
          ))}
        </div>
        <FieldError>{error("tagIds")}</FieldError>
        <Field>
          <FieldLabel htmlFor={`${id}-new-tags`}>Propose new tags</FieldLabel>
          <Input id={`${id}-new-tags`} name="newTags" placeholder="Separated by commas" />
          <FieldDescription>A steward decides whether they join the list.</FieldDescription>
        </Field>
      </FieldSet>

      <FieldSet data-invalid={error("visibility") ? true : undefined}>
        <FieldLegend variant="label">
          Who sees it
          <Unsure show={unsure("visibility")} />
        </FieldLegend>
        <RadioGroup name="visibility" defaultValue={defaults.visibility} className="flex flex-col gap-3">
          {(["all", "team", "private"] as const).map((value) => (
            <Field key={value} orientation="horizontal">
              <RadioGroupItem id={`${id}-visibility-${value}`} value={value} disabled={value === "team" && !teamName} />
              <div className="flex flex-col">
                <FieldLabel htmlFor={`${id}-visibility-${value}`} className="font-normal">
                  {value === "team" && teamName ? `${VISIBILITY_LABELS.team} (${teamName})` : VISIBILITY_LABELS[value]}
                </FieldLabel>
                <FieldDescription>{value === "team" && !teamName ? "You have no team." : visibilityDescriptions[value]}</FieldDescription>
              </div>
            </Field>
          ))}
        </RadioGroup>
        <FieldError>{error("visibility")}</FieldError>
      </FieldSet>

      <div className="flex flex-wrap gap-2">
        {status === "draft" ? (
          <>
            <Button type="submit" disabled={pending} onClick={() => (intent.current = "publish")}>
              Publish
            </Button>
            <Button type="submit" variant="outline" disabled={pending} onClick={() => (intent.current = "save")}>
              Save draft
            </Button>
          </>
        ) : (
          <Button type="submit" disabled={pending} onClick={() => (intent.current = "save")}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        )}
      </div>
    </form>
  );
}

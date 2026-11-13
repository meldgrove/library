import { ActionButton } from "@/components/admin/directory-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { NoteDetail } from "@/lib/library/notes";
import { formatKeyPoints, formatQuotes } from "@/lib/library/note-input";
import type { reviewOptions } from "@/lib/library/notes";
import { VISIBILITY_DESCRIPTIONS } from "./labels";
import { NoteForm } from "./note-form";
import { OriginalLink } from "./note-view";

type Action = Parameters<typeof NoteForm>[0]["action"];

/** The review of a draft, or the edit of a published note: the original, then the form. */
export function NoteReview({
  detail,
  options,
  saveAction,
  discardAction,
}: {
  detail: NoteDetail;
  options: Awaited<ReturnType<typeof reviewOptions>>;
  saveAction: Action;
  discardAction?: Action;
}) {
  const { note } = detail;
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{note.status === "draft" ? "Check the draft against the original" : "Edit the note"}</h2>
          </CardTitle>
          <CardDescription>
            {note.status === "draft"
              ? "The AI model drafted this note. Open the original, correct what is wrong, and publish. Nobody else sees the draft until then."
              : "Changes are saved as a new version and reach connected tools within a minute."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <OriginalLink detail={detail} />
          {detail.reasons.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              Why it was added: {detail.reasons.map((reason) => `${reason.reason} (${reason.personName})`).join("; ")}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <NoteForm
            action={saveAction}
            status={note.status === "published" ? "published" : "draft"}
            defaults={{
              title: note.title,
              core: note.core,
              keyPoints: formatKeyPoints(note.keyPoints),
              quotes: formatQuotes(note.quotes),
              citation: note.citation,
              language: note.language ?? "",
              documentTypeId: note.documentTypeId ?? "",
              projectId: note.projectId ?? "",
              tagIds: detail.tags.map((t) => t.id),
              visibility: note.visibility,
            }}
            uncertainFields={note.status === "draft" ? note.uncertainFields : []}
            documentTypes={options.types}
            projects={options.projects}
            tagGroups={options.tagGroups}
            teamName={detail.teamName}
            visibilityDescriptions={VISIBILITY_DESCRIPTIONS}
          />
        </CardContent>
      </Card>
      {discardAction ? (
        <section aria-labelledby="discard" className="flex flex-col gap-2 rounded-lg border p-4">
          <h2 id="discard" className="text-sm font-medium">
            Not worth a note?
          </h2>
          <p className="text-sm text-muted-foreground">Discard the draft. Later uploads of the same source are not drafted again.</p>
          <ActionButton action={discardAction} label="Discard draft" variant="outline" />
        </section>
      ) : null}
    </div>
  );
}

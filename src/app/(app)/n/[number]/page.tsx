import { Pencil } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/admin/directory-forms";
import { DeleteNoteForm } from "@/components/library/delete-note-form";
import { NoteReview } from "@/components/library/note-review";
import { NoteView } from "@/components/library/note-view";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { getFormatter, requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { canEditNote, canSeeNote, viewerOf } from "@/lib/library/access";
import { noteRef, parseNoteNumber } from "@/lib/library/constants";
import { getNoteByNumber, reviewOptions } from "@/lib/library/notes";
import { checkNoteAction, deleteNoteAction, discardNoteAction, saveNoteAction } from "./actions";

export const metadata: Metadata = { title: "Note" };

export default async function NotePage({ params }: PageProps<"/n/[number]">) {
  const { person } = await requireUser();
  const number = parseNoteNumber((await params).number);
  if (number === undefined) notFound();
  const db = getDb();
  const detail = await getNoteByNumber(db, number);
  const viewer = viewerOf(person);
  // Notes the person may not see look like missing ones.
  if (!detail || !canSeeNote(viewer, detail.note)) notFound();
  const { note } = detail;
  const editable = canEditNote(viewer, note);
  const header = <PageHeader title={note.title} eyebrow={<span className="text-sm text-muted-foreground">{noteRef(note.number)}</span>} />;

  if (note.status === "draft" && editable) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <NoteReview
          detail={detail}
          options={await reviewOptions(db, detail)}
          saveAction={saveNoteAction.bind(null, note.id)}
          discardAction={discardNoteAction.bind(null, note.id)}
        />
      </div>
    );
  }

  const fmt = await getFormatter();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={note.title}
        eyebrow={<span className="text-sm text-muted-foreground">{noteRef(note.number)}</span>}
        actions={
          editable && note.status === "published" ? (
            <Button asChild variant="outline">
              <Link href={`/n/${note.number}/edit`}>
                <Pencil aria-hidden="true" />
                Edit
              </Link>
            </Button>
          ) : null
        }
      />
      <NoteView detail={detail} fmt={fmt} />
      {person.isAdmin && note.status === "published" && !note.checkedAt ? (
        <section aria-labelledby="steward-check" className="flex flex-col gap-2 rounded-lg border p-4">
          <h2 id="steward-check" className="text-sm font-medium">
            Steward check
          </h2>
          <p className="text-sm text-muted-foreground">Mark the note as checked against its source. Readers and connected tools see the mark.</p>
          <ActionButton action={checkNoteAction.bind(null, note.id, note.number)} label="Mark as checked" variant="outline" />
        </section>
      ) : null}
      {editable ? (
        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer text-sm font-medium">Delete this note</summary>
          <div className="mt-4">
            <DeleteNoteForm action={deleteNoteAction.bind(null, note.id)} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

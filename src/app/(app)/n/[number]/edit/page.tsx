import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NoteHeader } from "@/components/library/note-header";
import { NoteReview } from "@/components/library/note-review";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { canEditNote, canSeeNote, viewerOf } from "@/lib/library/access";
import { parseNoteNumber } from "@/lib/library/constants";
import { getNoteByNumber, reviewOptions } from "@/lib/library/notes";
import { saveNoteAction } from "../actions";

export const metadata: Metadata = { title: "Edit note" };

export default async function EditNotePage({ params }: PageProps<"/n/[number]/edit">) {
  const { person } = await requireUser();
  const number = parseNoteNumber((await params).number);
  if (number === undefined) notFound();
  const db = getDb();
  const viewer = viewerOf(person);
  const detail = await getNoteByNumber(db, number, viewer);
  if (!detail || !canSeeNote(viewer, detail.note) || !canEditNote(viewer, detail.note) || detail.note.status !== "published") notFound();
  return (
    <div className="flex flex-col gap-6">
      <NoteHeader number={detail.note.number} title={`Edit ${detail.note.title}`} />
      <NoteReview detail={detail} options={await reviewOptions(db, detail)} saveAction={saveNoteAction.bind(null, detail.note.id)} />
    </div>
  );
}

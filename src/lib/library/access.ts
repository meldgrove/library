import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { canMaintain, type Role } from "@/lib/auth/roles";
import type { Database } from "@/lib/db/client";
import { note, source, submission, tagProposal } from "@/lib/db/schema";
import type { NoteStatus, Visibility } from "./constants";

/*
 * Who can see a note. One rule, as a pure function for pages and as an SQL
 * condition for lists and search, tested against each other.
 *
 * - Drafts and discarded notes: their owner, and maintainers (and admins),
 *   except private ones.
 * - Published notes: "all" for everyone with access, "team" for the owning
 *   team, the owner, and maintainers, "private" for the owner only.
 */

export interface Viewer {
  personId: string;
  teamId: string | null;
  role: Role;
}

export interface NoteAccessFields {
  status: NoteStatus;
  visibility: Visibility;
  ownerId: string;
  teamId: string | null;
}

export function canSeeNote(viewer: Viewer, target: NoteAccessFields): boolean {
  if (target.ownerId === viewer.personId) return true;
  if (target.visibility === "private") return false;
  if (canMaintain(viewer.role)) return true;
  if (target.status !== "published") return false;
  if (target.visibility === "all") return true;
  return target.teamId !== null && target.teamId === viewer.teamId;
}

/** The owner edits their note; maintainers edit every note they can see. */
export function canEditNote(viewer: Viewer, target: NoteAccessFields): boolean {
  return target.ownerId === viewer.personId || (canMaintain(viewer.role) && target.visibility !== "private");
}

/** `canSeeNote` as an SQL condition on the `note` table. */
export function visibleNotes(viewer: Viewer): SQL {
  const own = eq(note.ownerId, viewer.personId);
  if (canMaintain(viewer.role)) return or(own, sql`${note.visibility} <> 'private'`)!;
  const published = eq(note.status, "published");
  const forAll = and(published, eq(note.visibility, "all"));
  const forTeam = viewer.teamId ? and(published, eq(note.visibility, "team"), eq(note.teamId, viewer.teamId)) : undefined;
  return or(own, forAll, forTeam)!;
}

/** Use with tag proposals left joined to their notes. Standalone proposals are visible. */
export function visibleTagProposals(viewer: Viewer): SQL {
  return or(isNull(tagProposal.noteId), visibleNotes(viewer))!;
}

/** The viewer behind a request. */
export function viewerOf(person: { id: string; teamId: string | null; role: Role }): Viewer {
  return { personId: person.id, teamId: person.teamId, role: person.role };
}

/**
 * The source and its first submission are inserted in the same transaction.
 * Both timestamps default to PostgreSQL's transaction time. A later upload
 * must never inherit access if the original submission was deleted.
 */
export function creatingSubmitterOfSource(db: Database): SQL<string | null> {
  const original = alias(submission, "creating_submission");
  const uploader = db.select({ submitterId: original.submitterId }).from(original)
    .where(and(eq(original.sourceId, source.id), eq(original.createdAt, source.createdAt)))
    .orderBy(original.id).limit(1);
  return sql<string | null>`(${uploader})`;
}

/** A note drafted by a second uploader must not reveal the first uploader's filename. */
export function noteSourceFileName(db: Database): SQL<string | null> {
  const mayShow = or(isNull(note.id), eq(creatingSubmitterOfSource(db), note.ownerId));
  return sql<string | null>`case when ${mayShow} then ${source.fileName} end`;
}

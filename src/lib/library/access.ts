import { and, eq, exists, isNull, not, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { canMaintain, type Role } from "@/lib/auth/roles";
import type { Database } from "@/lib/db/client";
import { note, source, submission, tagProposal } from "@/lib/db/schema";
import type { NoteStatus, Visibility } from "./constants";

/*
 * Who can see a note, and what of its source. Each rule exists once, as a
 * pure function for pages and as SQL for lists and search, tested against
 * each other.
 *
 * - Drafts and discarded notes: their owner, and maintainers (and admins),
 *   except private ones.
 * - Published notes: "all" for everyone with access, "team" for the owning
 *   team, the owner, and maintainers, "private" for the owner only.
 * - Sources: see `canSeeSource`.
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
 * Who added the source first: the submitter of the upload that created it.
 * The source and its first submission are inserted in the same transaction,
 * and both timestamps default to PostgreSQL's transaction time. A later
 * upload must never inherit this if the original submission was deleted.
 */
export function creatingSubmitterOfSource(db: Database): SQL<string | null> {
  const original = alias(submission, "creating_submission");
  const uploader = db.select({ submitterId: original.submitterId }).from(original)
    .where(and(eq(original.sourceId, source.id), eq(original.createdAt, source.createdAt)))
    .orderBy(original.id).limit(1);
  return sql<string | null>`(${uploader})`;
}

export interface SourceAccessFields {
  /** Who added the source first; null once that upload is deleted. */
  creatorId: string | null;
  /** The source's note, if it has one. */
  note: NoteAccessFields | null;
  /** The upload the source is listed with became, or was linked to, its note. */
  uploadLinked: boolean;
}

export interface SourceAccess {
  /** The stored original, to download. */
  original: boolean;
  /** The saved link and the detected title. */
  details: boolean;
  /** The saved link in the maintenance queue, where maintainers decide on uploads on hold. */
  reviewLink: boolean;
  /** The original's file name. */
  fileName: boolean;
}

/**
 * A note shows its original's file name only when its owner added the source
 * first: a note drafted from a second upload must not reveal the first
 * uploader's file name.
 */
export function noteMayShowFileName(note: { ownerId: string }, creatorId: string | null): boolean {
  return creatorId !== null && note.ownerId === creatorId;
}

/**
 * What a viewer may see of a source. Duplicate uploads grant nothing; the
 * first uploader always sees what they added.
 *
 * - The original follows the note. Before a note exists: the first uploader
 *   and maintainers.
 * - The saved link and title: the first uploader, and, with an upload that
 *   became or was linked to the note, everyone who may see the note. In the
 *   maintenance queue, maintainers also see the link wherever they may get
 *   the original.
 * - The file name: the first uploader, and everyone who may get the original
 *   unless the note belongs to someone else.
 */
export function canSeeSource(viewer: Viewer, target: SourceAccessFields): SourceAccess {
  const firstUploader = target.creatorId === viewer.personId;
  const maintainer = canMaintain(viewer.role);
  const noteVisible = target.note !== null && canSeeNote(viewer, target.note);
  const original = target.note ? noteVisible : firstUploader || maintainer;
  const details = firstUploader || (noteVisible && target.uploadLinked);
  return {
    original,
    details,
    reviewLink: details || (maintainer && original),
    fileName: firstUploader || (original && (!target.note || noteMayShowFileName(target.note, target.creatorId))),
  };
}

/**
 * `canSeeSource` as SQL conditions on the `source` table, for any query that
 * has it, and on the upload the query lists it with, if any. Never null.
 */
export function sourceVisibility(db: Database, viewer: Viewer, upload?: { noteId: typeof submission.noteId }): Record<keyof SourceAccess, SQL> {
  const creator = creatingSubmitterOfSource(db);
  const firstUploader = sql`coalesce(${creator} = ${viewer.personId}, false)`;
  const maintainer = canMaintain(viewer.role);
  // The subqueries' own `note` shadows the caller's.
  const sourceNote = (condition?: SQL) => exists(db.select({ id: note.id }).from(note).where(and(eq(note.sourceId, source.id), condition)));
  const hasNote = sourceNote();
  const noteVisible = sourceNote(visibleNotes(viewer));
  const original = or(noteVisible, and(not(hasNote), maintainer ? undefined : firstUploader))!;
  const details = or(firstUploader, upload ? sourceNote(and(visibleNotes(viewer), eq(note.id, upload.noteId))) : undefined)!;
  return {
    original,
    details,
    reviewLink: maintainer ? or(details, original)! : details,
    fileName: or(firstUploader, and(original, or(not(hasNote), sourceNote(eq(note.ownerId, creator)))))!,
  };
}

/** The source's columns as the viewer may see them, listed with `upload` if given: hidden ones are null. */
export function visibleSourceColumns(db: Database, viewer: Viewer, upload?: { noteId: typeof submission.noteId }) {
  const can = sourceVisibility(db, viewer, upload);
  return {
    fileName: sql<string | null>`case when ${can.fileName} then ${source.fileName} end`,
    url: sql<string | null>`case when ${can.details} then ${source.url} end`,
    detectedTitle: sql<string | null>`case when ${can.details} then ${source.detectedTitle} end`,
    reviewUrl: sql<string | null>`case when ${can.reviewLink} then ${source.url} end`,
    hasOriginal: sql<boolean>`(${can.original} and ${source.storageKey} is not null)`,
  };
}

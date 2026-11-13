import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { note } from "@/lib/db/schema";
import type { NoteStatus, Visibility } from "./constants";

/*
 * Who can see a note. One rule, as a pure function for pages and as an SQL
 * condition for lists and search, tested against each other.
 *
 * - Drafts and discarded notes: their owner, and stewards (admins), except
 *   private ones.
 * - Published notes: "all" for everyone with access, "team" for the owning
 *   team, the owner, and stewards, "private" for the owner only.
 */

export interface Viewer {
  personId: string;
  teamId: string | null;
  /** Admins are the library's stewards. */
  isAdmin: boolean;
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
  if (viewer.isAdmin) return true;
  if (target.status !== "published") return false;
  if (target.visibility === "all") return true;
  return target.teamId !== null && target.teamId === viewer.teamId;
}

/** The owner edits their note; stewards edit every note they can see. */
export function canEditNote(viewer: Viewer, target: NoteAccessFields): boolean {
  return target.ownerId === viewer.personId || (viewer.isAdmin && target.visibility !== "private");
}

/** `canSeeNote` as an SQL condition on the `note` table. */
export function visibleNotes(viewer: Viewer): SQL {
  const own = eq(note.ownerId, viewer.personId);
  if (viewer.isAdmin) return or(own, sql`${note.visibility} <> 'private'`)!;
  const published = eq(note.status, "published");
  const forAll = and(published, eq(note.visibility, "all"));
  const forTeam = viewer.teamId ? and(published, eq(note.visibility, "team"), eq(note.teamId, viewer.teamId)) : undefined;
  return or(own, forAll, forTeam)!;
}

/** The viewer behind a request. */
export function viewerOf(person: { id: string; teamId: string | null; isAdmin: boolean }): Viewer {
  return { personId: person.id, teamId: person.teamId, isAdmin: person.isAdmin };
}

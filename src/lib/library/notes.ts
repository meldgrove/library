import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "@/lib/db/client";
import { documentType, note, noteReason, noteTag, person, project, source, tag, tagCluster, team } from "@/lib/db/schema";
import { visibleNotes, type Viewer } from "./access";

/* Reading notes: one note with everything its page shows, and lists for browsing and search. */

export async function getNoteByNumber(db: Database, number: number) {
  const [row] = await db
    .select({
      note,
      ownerName: person.displayName,
      teamName: team.name,
      documentTypeName: documentType.name,
      projectName: project.name,
      source: {
        id: source.id,
        kind: source.kind,
        url: source.url,
        fileName: source.fileName,
        mimeType: source.mimeType,
        sizeBytes: source.sizeBytes,
        storageKey: source.storageKey,
        extractionMethod: source.extractionMethod,
        textChars: source.textChars,
        doi: source.doi,
      },
    })
    .from(note)
    .innerJoin(person, eq(person.id, note.ownerId))
    .innerJoin(source, eq(source.id, note.sourceId))
    .leftJoin(team, eq(team.id, note.teamId))
    .leftJoin(documentType, eq(documentType.id, note.documentTypeId))
    .leftJoin(project, eq(project.id, note.projectId))
    .where(eq(note.number, number));
  if (!row) return undefined;
  const [tags, reasons] = await Promise.all([
    db
      .select({ id: tag.id, name: tag.name })
      .from(noteTag)
      .innerJoin(tag, eq(tag.id, noteTag.tagId))
      .where(eq(noteTag.noteId, row.note.id))
      .orderBy(asc(tag.name)),
    db
      .select({ id: noteReason.id, reason: noteReason.reason, createdAt: noteReason.createdAt, personName: person.displayName })
      .from(noteReason)
      .innerJoin(person, eq(person.id, noteReason.personId))
      .where(eq(noteReason.noteId, row.note.id))
      .orderBy(asc(noteReason.createdAt)),
  ]);
  return { ...row, tags, reasons };
}

export type NoteDetail = NonNullable<Awaited<ReturnType<typeof getNoteByNumber>>>;

export interface NoteFilters {
  /** Full-text search over title, core, key points, quotes, citation, and tags. */
  q?: string;
  tagId?: string;
  documentTypeId?: string;
  projectId?: string;
  teamId?: string;
  ownerId?: string;
  /** The note with this number (LIB-<number>). */
  number?: number;
  /** Published on or after this date (YYYY-MM-DD). */
  from?: string;
  limit?: number;
  offset?: number;
}

/** Published notes the viewer can see, newest first, or by relevance when searching. */
export async function listNotes(db: Database, viewer: Viewer, filters: NoteFilters = {}) {
  const conditions: (SQL | undefined)[] = [eq(note.status, "published"), visibleNotes(viewer)];
  const query = filters.q?.trim();
  const tsQuery = query ? sql`websearch_to_tsquery('simple', ${query}) || websearch_to_tsquery('english', ${query}) || websearch_to_tsquery('german', ${query})` : undefined;
  if (tsQuery) conditions.push(sql`${note.searchVector} @@ (${tsQuery})`);
  if (filters.tagId) conditions.push(sql`exists (select 1 from note_tag where note_tag.note_id = ${note.id} and note_tag.tag_id = ${filters.tagId})`);
  if (filters.documentTypeId) conditions.push(eq(note.documentTypeId, filters.documentTypeId));
  if (filters.projectId) conditions.push(eq(note.projectId, filters.projectId));
  if (filters.teamId) conditions.push(eq(note.teamId, filters.teamId));
  if (filters.ownerId) conditions.push(eq(note.ownerId, filters.ownerId));
  if (filters.number !== undefined) conditions.push(eq(note.number, filters.number));
  if (filters.from) conditions.push(sql`${note.publishedAt} >= ${filters.from}::date`);

  const rows = await db
    .select({
      id: note.id,
      number: note.number,
      title: note.title,
      core: note.core,
      visibility: note.visibility,
      publishedAt: note.publishedAt,
      checkedAt: note.checkedAt,
      ownerName: person.displayName,
      teamName: team.name,
      documentTypeName: documentType.name,
      total: sql<number>`count(*) over ()::int`,
    })
    .from(note)
    .innerJoin(person, eq(person.id, note.ownerId))
    .leftJoin(team, eq(team.id, note.teamId))
    .leftJoin(documentType, eq(documentType.id, note.documentTypeId))
    .where(and(...conditions))
    .orderBy(...(tsQuery ? [desc(sql`ts_rank(${note.searchVector}, (${tsQuery}))`), desc(note.publishedAt)] : [desc(note.publishedAt)]))
    .limit(filters.limit ?? 50)
    .offset(filters.offset ?? 0);

  const tagsByNote = new Map<string, { id: string; name: string }[]>();
  if (rows.length > 0) {
    const tagRows = await db
      .select({ noteId: noteTag.noteId, id: tag.id, name: tag.name })
      .from(noteTag)
      .innerJoin(tag, eq(tag.id, noteTag.tagId))
      .where(inArray(noteTag.noteId, rows.map((row) => row.id)))
      .orderBy(asc(tag.name));
    for (const row of tagRows) tagsByNote.set(row.noteId, [...(tagsByNote.get(row.noteId) ?? []), { id: row.id, name: row.name }]);
  }
  return {
    total: rows[0]?.total ?? 0,
    notes: rows.map(({ total: _, ...row }) => ({ ...row, tags: tagsByNote.get(row.id) ?? [] })),
  };
}

/** The values the filters offer: active tags, document types, projects, and teams. */
export async function filterOptions(db: Database) {
  const [tags, types, projects, teams] = await Promise.all([
    db.select({ id: tag.id, name: tag.name }).from(tag).where(eq(tag.isActive, true)).orderBy(sql`lower(${tag.name})`),
    db.select({ id: documentType.id, name: documentType.name }).from(documentType).where(eq(documentType.isActive, true)).orderBy(sql`lower(${documentType.name})`),
    db.select({ id: project.id, name: project.name }).from(project).where(eq(project.isActive, true)).orderBy(sql`lower(${project.name})`),
    db.select({ id: team.id, name: team.name }).from(team).where(eq(team.isActive, true)).orderBy(sql`lower(${team.name})`),
  ]);
  return { tags, types, projects, teams };
}

/** What the review form offers: active entries, plus the note's current ones even when inactive. */
export async function reviewOptions(db: Database, detail: NoteDetail) {
  const currentTagIds = detail.tags.map((t) => t.id);
  const [types, projects, tags] = await Promise.all([
    db
      .select({ id: documentType.id, name: documentType.name })
      .from(documentType)
      .where(or(eq(documentType.isActive, true), detail.note.documentTypeId ? eq(documentType.id, detail.note.documentTypeId) : sql`false`))
      .orderBy(sql`lower(${documentType.name})`),
    db
      .select({ id: project.id, name: project.name })
      .from(project)
      .where(or(eq(project.isActive, true), detail.note.projectId ? eq(project.id, detail.note.projectId) : sql`false`))
      .orderBy(sql`lower(${project.name})`),
    db
      .select({ id: tag.id, name: tag.name, cluster: tagCluster.name })
      .from(tag)
      .leftJoin(tagCluster, eq(tagCluster.id, tag.clusterId))
      .where(or(eq(tag.isActive, true), currentTagIds.length > 0 ? inArray(tag.id, currentTagIds) : sql`false`))
      .orderBy(sql`${tagCluster.name} nulls last`, sql`lower(${tag.name})`),
  ]);
  const groups = new Map<string, { id: string; name: string }[]>();
  for (const t of tags) {
    const cluster = t.cluster ?? "Other";
    groups.set(cluster, [...(groups.get(cluster) ?? []), { id: t.id, name: t.name }]);
  }
  return { types, projects, tagGroups: [...groups].map(([cluster, groupTags]) => ({ cluster, tags: groupTags })) };
}

import { and, asc, desc, eq, exists, gte, inArray, isNotNull, lt, ne, sql, type SQL } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { CommandError, type Actor } from "@/lib/commands";
import type { Database, Transaction } from "@/lib/db/client";
import { documentType, note, noteTag, person, tag, tagCluster, tagSubscription, team } from "@/lib/db/schema";
import { clipText, isoWeek, serverDate, serverDateTime } from "@/lib/format";
import type { DigestItem, DigestSpec, NotificationMessage } from "@/lib/notifications/types";
import { viewerOf, visibleNotes, type Viewer } from "./access";
import { notePath, noteRef, SLACK_CHANNEL_ID_PATTERN, type NoteQuote } from "./constants";
import { emailToAddress, notifyPerson, postToChannel } from "./notify";

/*
 * The weekly digest, Mondays at 09:00 (server time), with the notes
 * published since the Monday 09:00 before. Plain code, no AI model.
 *
 * - The library's Slack channel (DIGEST_SLACK_CHANNEL_ID) and mailing list
 *   (DIGEST_EMAIL_TO) get notes for everyone.
 * - A team's Slack channel gets the team's notes for everyone or the team.
 * - Each person who follows tags gets an email with the new notes that carry
 *   one of them and that they may see (`visibleNotes`), except their own.
 *
 * Private notes never go to a channel or a list. Each message is recorded
 * once per ISO week and rebuilt from the notes as they are before each send.
 */

export const DIGEST_DAYS = 7;
/** The hour digests go out, in the server's time zone. */
export const DIGEST_HOUR = 9;

const addDays = (date: string, days: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
};

/**
 * The digest week for `now`: from one Monday 09:00 to the next (server time,
 * so a week across a clock change has 167 or 169 hours), ending at the latest
 * Monday 09:00 at or before `now`. A retry later in the week gets the same
 * window, and `week` names it.
 */
export function digestWindow(now: Date): { since: Date; until: Date; week: string } {
  const today = serverDate(now);
  const [y, m, d] = today.split("-").map(Number);
  const daysSinceMonday = (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7;
  let monday = addDays(today, -daysSinceMonday);
  if (serverDateTime(monday, DIGEST_HOUR) > now) monday = addDays(monday, -7);
  return { since: serverDateTime(addDays(monday, -7), DIGEST_HOUR), until: serverDateTime(monday, DIGEST_HOUR), week: isoWeek(monday) };
}
/** The newest notes a digest lists; the library has the rest. */
export const DIGEST_MAX_ITEMS = 50;
const SUMMARY_MAX = 280;
const QUOTE_MAX = 300;
/** Notes whose first tag has no cluster. */
export const OTHER_SECTION = "Other";

export interface DigestNote {
  number: number;
  title: string;
  core: string;
  quotes: NoteQuote[];
  publishedAt: Date;
  documentType: string | null;
  /** The note's tags, each with its cluster. */
  tags: { name: string; cluster: string | null }[];
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });

function digestItem(digestNote: DigestNote, tags: DigestNote["tags"]): DigestItem {
  const meta = [digestNote.documentType, tags.map((t) => t.name).join(", ")].filter(Boolean).join(" · ");
  return {
    ref: noteRef(digestNote.number),
    title: digestNote.title,
    path: notePath(digestNote.number),
    summary: clipText(digestNote.core.replace(/\s+/g, " ").trim(), SUMMARY_MAX),
    ...(meta ? { meta } : {}),
  };
}

/**
 * The digest of `notes` (newest first after sorting), or null when there are
 * none: sections by the cluster of each note's first tag (by name), "Other"
 * last, and the newest quote as the quote of the week.
 */
export function buildDigestMessage(notes: DigestNote[], options: DigestSpec["options"] = {}, spec?: DigestSpec): NotificationMessage | null {
  if (notes.length === 0) return null;
  const newest = [...notes].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  const listed = newest.slice(0, DIGEST_MAX_ITEMS);
  const sections = new Map<string, DigestItem[]>();
  for (const digestNote of listed) {
    const tags = [...digestNote.tags].sort(byName);
    const heading = tags[0]?.cluster ?? OTHER_SECTION;
    sections.set(heading, [...(sections.get(heading) ?? []), digestItem(digestNote, tags)]);
  }
  const headings = [...sections.keys()].sort((a, b) => (a === OTHER_SECTION ? 1 : b === OTHER_SECTION ? -1 : a.localeCompare(b, "en", { sensitivity: "base" })));

  const count = notes.length;
  const counted = count === 1 ? "1 new note" : `${count} new notes`;
  const lines = [`${counted} ${count === 1 ? "was" : "were"} published in the library last week${options.audience ? ` ${options.audience}` : ""}.`];
  if (count > listed.length) lines.push(`The ${listed.length} newest are listed here; the library has all of them.`);
  const quoted = newest.find((n) => n.quotes.length > 0);
  if (quoted) {
    lines.push(`Quote of the week: “${clipText(quoted.quotes[0]!.text.replace(/\s+/g, " ").trim(), QUOTE_MAX)}” (${noteRef(quoted.number)} · ${quoted.title})`);
  }
  return {
    subject: `Library digest: ${counted}`,
    title: options.title ?? "Weekly library digest",
    text: lines.join("\n"),
    path: "/",
    sections: headings.map((heading) => ({ heading, items: sections.get(heading)! })),
    ...(options.footer ? { footer: options.footer } : {}),
    ...(spec ? { digest: spec } : {}),
  };
}

/** Published notes that match `where`, with their tags and clusters, newest first. */
export async function digestNotes(db: Database | Transaction, where: SQL | undefined): Promise<(DigestNote & { id: string })[]> {
  const rows = await db
    .select({
      id: note.id,
      number: note.number,
      title: note.title,
      core: note.core,
      quotes: note.quotes,
      publishedAt: note.publishedAt,
      documentType: documentType.name,
    })
    .from(note)
    .leftJoin(documentType, eq(documentType.id, note.documentTypeId))
    .where(and(eq(note.status, "published"), isNotNull(note.publishedAt), where))
    .orderBy(desc(note.publishedAt));
  if (rows.length === 0) return [];
  const tagRows = await db
    .select({ noteId: noteTag.noteId, name: tag.name, cluster: tagCluster.name })
    .from(noteTag)
    .innerJoin(tag, eq(tag.id, noteTag.tagId))
    .leftJoin(tagCluster, eq(tagCluster.id, tag.clusterId))
    .where(inArray(noteTag.noteId, rows.map((row) => row.id)))
    .orderBy(asc(tag.name));
  const tagsByNote = new Map<string, DigestNote["tags"]>();
  for (const row of tagRows) tagsByNote.set(row.noteId, [...(tagsByNote.get(row.noteId) ?? []), { name: row.name, cluster: row.cluster }]);
  return rows.map((row) => ({ ...row, publishedAt: row.publishedAt!, tags: tagsByNote.get(row.id) ?? [] }));
}

/** Published in the window: from `since` (included) to `until` (excluded). */
export const publishedIn = (window: { since: Date; until: Date }) => and(gte(note.publishedAt, window.since), lt(note.publishedAt, window.until));

/** Notes for everyone. */
export const forAllStaff = () => eq(note.visibility, "all");
/** A team's notes for everyone or for the team; never private ones. */
export const forTeam = (teamId: string) => and(eq(note.teamId, teamId), inArray(note.visibility, ["all", "team"]));

export interface DigestTargets {
  /** The library's Slack channel for notes for everyone. */
  slackChannelId?: string;
  /** The mailing list for notes for everyone. */
  emailTo?: string;
}

export interface DigestResult {
  /** Posts recorded this time. */
  posted: number;
  /** Channels without new notes. */
  empty: number;
}

/** Who may read a digest's notes: the audience's rule, applied again before each send. */
export function audienceCondition(audience: DigestSpec["audience"], viewer?: Viewer): SQL | undefined {
  switch (audience.kind) {
    case "all":
      return forAllStaff();
    case "team":
      return forTeam(audience.teamId);
    case "person":
      // Their own notes are no news to them, and so "Only me" notes never go to a digest.
      return viewer ? and(visibleNotes(viewer), ne(note.ownerId, viewer.personId)) : sql`false`;
  }
}

/** Records a digest of the notes that match `where` in `window`, with what it takes to rebuild it before sending. */
export async function digestMessage(
  db: Database | Transaction,
  window: { since: Date; until: Date },
  audience: DigestSpec["audience"],
  options: DigestSpec["options"],
  viewer?: Viewer,
  where?: SQL,
): Promise<NotificationMessage | null> {
  const notes = await digestNotes(db, and(publishedIn(window), audienceCondition(audience, viewer), where));
  return buildDigestMessage(notes, options, { noteIds: notes.map((n) => n.id), audience, options });
}

/**
 * The digest as it may go out now: its recorded notes that are still
 * published and still for its audience (for a person: that they may still
 * see). Null when none is left.
 */
export async function rebuildDigest(db: Database | Transaction, spec: DigestSpec, viewer?: Viewer): Promise<NotificationMessage | null> {
  if (spec.noteIds.length === 0) return null;
  const notes = await digestNotes(db, and(inArray(note.id, spec.noteIds), audienceCondition(spec.audience, viewer)));
  return buildDigestMessage(notes, spec.options, spec);
}

/** The week's digests: one post per channel, recorded once per ISO week. */
export async function recordWeeklyDigests(db: Database, now: Date, targets: DigestTargets): Promise<DigestResult> {
  const window = digestWindow(now);
  const result: DigestResult = { posted: 0, empty: 0 };
  const post = async (key: string, channelId: string, audience: DigestSpec["audience"], text?: string) => {
    const message = await digestMessage(db, window, audience, { audience: text });
    if (!message) {
      result.empty += 1;
      return;
    }
    if (await postToChannel(db, { event: "weekly_digest", key: `${window.week}:${key}`, channelId, message })) result.posted += 1;
  };

  if (targets.slackChannelId) await post("all", targets.slackChannelId, { kind: "all" });
  if (targets.emailTo) {
    const footer = `The library sends this digest every Monday to ${targets.emailTo}.`;
    const message = await digestMessage(db, window, { kind: "all" }, { footer });
    if (!message) result.empty += 1;
    else if (await emailToAddress(db, { event: "weekly_digest", key: `${window.week}:all`, address: targets.emailTo, message })) result.posted += 1;
  }
  const teams = await db
    .select({ id: team.id, name: team.name, channelId: team.digestSlackChannelId })
    .from(team)
    .where(and(eq(team.isActive, true), isNotNull(team.digestSlackChannelId)));
  for (const t of teams) await post(`team:${t.id}`, t.channelId!, { kind: "team", teamId: t.id }, `by ${t.name}`);
  return result;
}

/**
 * Each person who follows tags gets one email (Slack when email cannot reach
 * them) with the notes of the week by others that carry one of their tags and
 * that they may see. People without new notes get nothing. Returns how many
 * were recorded.
 */
export async function recordPersonalDigests(db: Database, now: Date): Promise<number> {
  const window = digestWindow(now);
  const subscribers = await db
    .select({ id: person.id, teamId: person.teamId, isAdmin: person.isAdmin })
    .from(person)
    .where(and(eq(person.hasAccess, true), exists(db.select({ one: sql`1` }).from(tagSubscription).where(eq(tagSubscription.personId, person.id)))));
  let recorded = 0;
  for (const subscriber of subscribers) {
    const followed = await db
      .select({ id: tag.id, name: tag.name })
      .from(tagSubscription)
      .innerJoin(tag, eq(tag.id, tagSubscription.tagId))
      .where(eq(tagSubscription.personId, subscriber.id))
      .orderBy(asc(tag.name));
    const withFollowedTag = exists(
      db
        .select({ one: sql`1` })
        .from(noteTag)
        .where(and(eq(noteTag.noteId, note.id), inArray(noteTag.tagId, followed.map((t) => t.id)))),
    );
    // The "person" audience leaves out their own notes, so "Only me" notes never go to a digest.
    const message = await digestMessage(db, window, { kind: "person" }, {
      audience: "with tags you follow",
      title: "Your weekly the library digest",
      footer: `You get this email because you follow these tags in the library: ${followed.map((t) => t.name).join(", ")}. Change them under Settings.`,
    }, viewerOf(subscriber), withFollowedTag);
    if (!message) continue;
    await notifyPerson(db, { event: "personal_digest", subjectKey: window.week, recipientId: subscriber.id, channel: "email", message });
    recorded += 1;
  }
  return recorded;
}

/** A steward sets the Slack channel for a team's weekly digest, or removes it (null). */
export async function setTeamDigestChannel(db: Database, actor: Actor, teamId: string, channelId: string | null): Promise<void> {
  if (!actor.isAdmin) throw new CommandError("forbidden", "Only stewards can do this.");
  if (channelId !== null && !SLACK_CHANNEL_ID_PATTERN.test(channelId)) {
    throw new CommandError("invalid", "Enter a Slack channel ID such as C0123456789.", { channelId: "Enter a Slack channel ID such as C0123456789." });
  }
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(team).where(eq(team.id, teamId)).for("update");
    if (!current) throw new CommandError("not_found", "This team does not exist.");
    if (current.digestSlackChannelId === channelId) return;
    await tx.update(team).set({ digestSlackChannelId: channelId, updatedAt: sql`now()` }).where(eq(team.id, teamId));
    await recordAudit(tx, {
      actorId: actor.personId,
      action: "team.digest_channel_changed",
      subjectType: "team",
      subjectId: teamId,
      payload: { from: current.digestSlackChannelId, to: channelId },
    });
  });
}

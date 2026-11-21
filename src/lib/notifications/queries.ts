import { and, count, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/lib/db/client";
import { note, NOTIFICATION_CHANNELS, notificationDelivery, person, type DeliveryStatus, type NotificationChannel } from "@/lib/db/schema";
import type { LibraryEvent } from "@/lib/library/notify";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Events whose message is about one note and names it in the subject. */
const NOTE_EVENTS = ["draft_ready", "review_reminder", "review_escalated"] as const satisfies readonly LibraryEvent[];
export const HIDDEN_NOTE_SUBJECT = "A message about a private or deleted note";

/** What the admin page shows about notifications. */
export async function getNotificationStatus(db: Database, now: Date = new Date()) {
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const failedSince = new Date(now.getTime() - 30 * DAY_MS);
  const isFailed = and(eq(notificationDelivery.status, "failed"), gte(notificationDelivery.createdAt, failedSince));
  const [counts, [failedTotal], failed, withoutSlack] = await Promise.all([
    db
      .select({ channel: notificationDelivery.channel, status: notificationDelivery.status, value: count() })
      .from(notificationDelivery)
      .where(gte(notificationDelivery.createdAt, since))
      .groupBy(notificationDelivery.channel, notificationDelivery.status),
    db.select({ value: count() }).from(notificationDelivery).where(isFailed),
    db
      .select({
        id: notificationDelivery.id,
        createdAt: notificationDelivery.createdAt,
        channel: notificationDelivery.channel,
        channelId: notificationDelivery.channelId,
        event: notificationDelivery.event,
        subject: notificationDelivery.message,
        recipientName: person.displayName,
        noteNumber: note.number,
        // The subject of a message about one note names it. A private note is its
        // owner's alone, and a deleted one is gone: both stay anonymous here.
        noteHidden: sql<boolean>`(${notificationDelivery.event} in (${sql.join(NOTE_EVENTS.map((event) => sql`${event}`), sql`, `)}) and (${note.id} is null or ${note.visibility} = 'private'))`,
        lastError: notificationDelivery.lastError,
      })
      .from(notificationDelivery)
      .leftJoin(person, eq(person.id, notificationDelivery.recipientId))
      .leftJoin(note, eq(note.id, notificationDelivery.noteId))
      .where(isFailed)
      .orderBy(desc(notificationDelivery.createdAt))
      .limit(20),
    db
      .select({ id: person.id, displayName: person.displayName, workEmail: person.workEmail, since: person.slackLookupFailedAt })
      .from(person)
      .where(and(eq(person.hasAccess, true), isNotNull(person.slackLookupFailedAt)))
      .orderBy(person.displayName),
  ]);

  const totals = (channel: NotificationChannel) => {
    const byStatus: Record<DeliveryStatus, number> = { pending: 0, sent: 0, skipped: 0, failed: 0 };
    for (const row of counts) if (row.channel === channel) byStatus[row.status] = row.value;
    return byStatus;
  };
  return {
    lastWeek: Object.fromEntries(NOTIFICATION_CHANNELS.map((channel) => [channel, totals(channel)])) as Record<NotificationChannel, Record<DeliveryStatus, number>>,
    /** Failed in the last 30 days. */
    failedTotal: failedTotal?.value ?? 0,
    /** The latest 20 of them. `address` names a list address; a Slack channel's ID would mean nothing to people. */
    failed: failed.map(({ subject, channelId, noteHidden, ...row }) => ({
      ...row,
      noteNumber: noteHidden ? null : row.noteNumber,
      subject: noteHidden ? HIDDEN_NOTE_SUBJECT : subject.subject,
      address: row.channel === "email_address" ? channelId : null,
    })),
    withoutSlack,
  };
}

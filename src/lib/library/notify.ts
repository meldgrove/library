import { and, eq } from "drizzle-orm";
import type { Database, Transaction } from "@/lib/db/client";
import { notificationDelivery, person, type NotificationChannel } from "@/lib/db/schema";
import type { NotificationMessage } from "@/lib/notifications/types";

/*
 * Library events become rows in `notification_delivery`, written in the
 * command's transaction; only the worker sends them. Each delivery key names
 * the event, the subject, and the recipient, so nothing is sent twice.
 * Messages carry titles and links, never the note's or the source's text.
 */

export type LibraryEvent =
  | "draft_ready"
  | "quarantined"
  | "duplicate"
  | "blocked"
  | "parked"
  | "review_reminder"
  | "review_escalated"
  | "published_for_steward"
  | "intake_reply"
  | "personal_digest";

export interface PersonMessage {
  event: LibraryEvent;
  /** What the event is about, e.g. the submission or note ID, plus an occurrence when it can repeat. */
  subjectKey: string;
  recipientId: string;
  /** Preferred channel; the worker falls back to the other one. */
  channel: Exclude<NotificationChannel, "slack_channel" | "email_address">;
  noteId?: string | null;
  message: NotificationMessage;
}

export async function notifyPerson(tx: Database | Transaction, delivery: PersonMessage): Promise<void> {
  await tx
    .insert(notificationDelivery)
    .values({
      deliveryKey: `${delivery.event}:${delivery.subjectKey}:${delivery.recipientId}`,
      event: delivery.event,
      noteId: delivery.noteId ?? null,
      recipientId: delivery.recipientId,
      channel: delivery.channel,
      message: delivery.message,
    })
    .onConflictDoNothing({ target: notificationDelivery.deliveryKey });
}

/** Posts to a Slack channel, such as a digest. */
export async function postToChannel(
  tx: Database | Transaction,
  post: { event: string; key: string; channelId: string; message: NotificationMessage },
): Promise<boolean> {
  const inserted = await tx
    .insert(notificationDelivery)
    .values({
      deliveryKey: `${post.event}:${post.key}:${post.channelId}`,
      event: post.event,
      channelId: post.channelId,
      channel: "slack_channel",
      message: post.message,
    })
    .onConflictDoNothing({ target: notificationDelivery.deliveryKey })
    .returning({ id: notificationDelivery.id });
  return inserted.length > 0;
}

/** Emails an address that belongs to no person, such as a mailing list for a digest. */
export async function emailToAddress(
  tx: Database | Transaction,
  email: { event: string; key: string; address: string; message: NotificationMessage },
): Promise<boolean> {
  const inserted = await tx
    .insert(notificationDelivery)
    .values({
      deliveryKey: `${email.event}:${email.key}:${email.address}`,
      event: email.event,
      channelId: email.address,
      channel: "email_address",
      message: email.message,
    })
    .onConflictDoNothing({ target: notificationDelivery.deliveryKey })
    .returning({ id: notificationDelivery.id });
  return inserted.length > 0;
}

/** The stewards: admins with access. */
export async function stewardIds(tx: Database | Transaction): Promise<string[]> {
  const rows = await tx
    .select({ id: person.id })
    .from(person)
    .where(and(eq(person.hasAccess, true), eq(person.isAdmin, true)));
  return rows.map((row) => row.id);
}

/** Tells every steward, e.g. about a quarantined upload. */
export async function notifyStewards(tx: Database | Transaction, delivery: Omit<PersonMessage, "recipientId">): Promise<void> {
  for (const id of await stewardIds(tx)) await notifyPerson(tx, { ...delivery, recipientId: id });
}

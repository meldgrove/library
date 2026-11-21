import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { note, notificationDelivery, source } from "@/lib/db/schema";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { getNotificationStatus, HIDDEN_NOTE_SUBJECT } from "./queries";

const testDb = connectTestDatabase();
const db = testDb.db;

beforeEach(async () => {
  await testDb.reset();
});

afterAll(async () => {
  await testDb.close();
});

describe("getNotificationStatus", () => {
  it("counts every channel, digests to a list address too", async () => {
    const { people } = await seedDirectory(db);
    const message = { subject: "Weekly digest", title: "Weekly digest", text: "New notes this week.", path: "/" };
    await db.insert(notificationDelivery).values([
      { deliveryKey: "digest:1:list", event: "digest", channel: "email_address", channelId: "list@example.org", status: "sent", message },
      { deliveryKey: "digest:2:list", event: "digest", channel: "email_address", channelId: "list@example.org", status: "failed", lastError: "SMTP 550: no such list", message },
      { deliveryKey: "digest:1:channel", event: "digest", channel: "slack_channel", channelId: "C0123", status: "sent", message },
      { deliveryKey: "digest:1:ada", event: "digest", channel: "slack", recipientId: people.ada.id, status: "skipped", message },
      { deliveryKey: "digest:1:dan", event: "digest", channel: "email", recipientId: people.dan.id, message },
    ]);

    const status = await getNotificationStatus(db);
    expect(status.lastWeek).toEqual({
      slack: { pending: 0, sent: 0, skipped: 1, failed: 0 },
      email: { pending: 1, sent: 0, skipped: 0, failed: 0 },
      slack_channel: { pending: 0, sent: 1, skipped: 0, failed: 0 },
      email_address: { pending: 0, sent: 1, skipped: 0, failed: 1 },
    });
    expect(status.failedTotal).toBe(1);
    expect(status.failed).toEqual([
      expect.objectContaining({ channel: "email_address", recipientName: null, address: "list@example.org", lastError: "SMTP 550: no such list" }),
    ]);
  });

  it("names no private or deleted note in the failed messages", async () => {
    const { people } = await seedDirectory(db);
    const sources = await db.insert(source).values([{ kind: "link", url: "https://example.com/a" }, { kind: "link", url: "https://example.com/b" }, { kind: "link", url: "https://example.com/c" }]).returning();
    const notes = await db
      .insert(note)
      .values(["Shared study", "Confidential study", "Withdrawn study"].map((title, index) => ({ sourceId: sources[index]!.id, ownerId: people.ada.id, visibility: index === 1 ? ("private" as const) : ("all" as const), title, core: "Summary" })))
      .returning();
    await db.insert(notificationDelivery).values(
      notes.map((row) => ({
        deliveryKey: `draft_ready:${row.id}:ada`,
        event: "draft_ready",
        channel: "email" as const,
        recipientId: people.ada.id,
        noteId: row.id,
        status: "failed" as const,
        message: { subject: `Review your draft: LIB-${row.number} ${row.title}`, title: row.title, text: "Ready.", path: `/n/${row.number}` },
      })),
    );
    await db.delete(note).where(eq(note.id, notes[2]!.id));

    const failed = (await getNotificationStatus(db)).failed.map(({ subject, noteNumber }) => ({ subject, noteNumber }));
    expect(failed).toHaveLength(3);
    expect(failed).toEqual(
      expect.arrayContaining([
        { subject: `Review your draft: LIB-${notes[0]!.number} Shared study`, noteNumber: notes[0]!.number },
        { subject: HIDDEN_NOTE_SUBJECT, noteNumber: null },
        { subject: HIDDEN_NOTE_SUBJECT, noteNumber: null },
      ]),
    );
    expect(JSON.stringify(failed)).not.toMatch(/Confidential|Withdrawn/);
  });
});

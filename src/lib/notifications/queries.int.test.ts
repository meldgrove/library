import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { notificationDelivery } from "@/lib/db/schema";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { getNotificationStatus } from "./queries";

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
});

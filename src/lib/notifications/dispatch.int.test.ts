import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { notificationDelivery, person } from "@/lib/db/schema";
import { emailToAddress, notifyPerson } from "@/lib/library/notify";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { dispatchDue } from "./dispatch";
import type { Email, Transports } from "./transports";
import type { NotificationMessage } from "./types";

const testDb = connectTestDatabase();
const db = testDb.db;
let seed: Awaited<ReturnType<typeof seedDirectory>>;
let sent: Email[];
let slackPosts: { to: string; text: string }[];

const transports = (options: { email?: boolean } = {}): Transports => ({
  baseUrl: "https://library.example",
  email: options.email === false ? undefined : { mode: "live", kind: "test", send: async (email) => void sent.push(email) },
  slack: {
    mode: "live",
    lookupUserByEmail: async () => "U0ADA",
    postMessage: async (to, text) => void slackPosts.push({ to, text }),
  },
});

const DIGEST: NotificationMessage = {
  subject: "Library digest: 1 new note",
  title: "Weekly library digest",
  text: "1 new note was published in the library in the last 7 days.",
  path: "/",
  sections: [{ heading: "Climate", items: [{ ref: "LIB-1", title: "Heat", path: "/n/1", summary: "Cities heat up." }] }],
  footer: "The library sends this digest every Monday to all-staff@example.org.",
};

afterAll(() => testDb.close());
beforeEach(async () => {
  await testDb.reset();
  seed = await seedDirectory(db);
  sent = [];
  slackPosts = [];
});

describe("dispatch to an email address", () => {
  it("sends the email to the address, greeting nobody by name", async () => {
    expect(await emailToAddress(db, { event: "weekly_digest", key: "2026-W47:all", address: "all-staff@example.org", message: DIGEST })).toBe(true);
    expect(await emailToAddress(db, { event: "weekly_digest", key: "2026-W47:all", address: "all-staff@example.org", message: DIGEST })).toBe(false);
    expect(await dispatchDue(db, transports())).toEqual({ sent: 1, skipped: 0, retry: 0, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "all-staff@example.org", subject: "Library digest: 1 new note" });
    expect(sent[0]!.toName).toBeUndefined();
    expect(sent[0]!.text.split("\n")[0]).toBe("Hello,");
    expect(sent[0]!.text).toContain("- LIB-1 · Heat: Cities heat up.\n  https://library.example/n/1");
    expect(sent[0]!.text).toContain("every Monday to all-staff@example.org");
    expect(slackPosts).toHaveLength(0);
    const [row] = await db.select().from(notificationDelivery);
    expect(row).toMatchObject({ status: "sent", channel: "email_address", channelId: "all-staff@example.org", recipientId: null });
  });

  it("skips it while email is off, and never posts it to Slack instead", async () => {
    await emailToAddress(db, { event: "weekly_digest", key: "2026-W47:all", address: "all-staff@example.org", message: DIGEST });
    expect(await dispatchDue(db, transports({ email: false }))).toEqual({ sent: 0, skipped: 1, retry: 0, failed: 0 });
    expect(slackPosts).toHaveLength(0);
    expect((await db.select().from(notificationDelivery))[0]).toMatchObject({ status: "skipped", lastError: "Email is not configured." });
  });

  it("still sends messages to people by name", async () => {
    await db.update(person).set({ workEmail: "ada@example.org" }).where(eq(person.id, seed.people.ada.id));
    await notifyPerson(db, { event: "intake_reply", subjectKey: "email:x", recipientId: seed.people.ada.id, channel: "email", message: { ...DIGEST, sections: undefined } });
    await dispatchDue(db, transports());
    expect(sent[0]).toMatchObject({ to: "ada@example.org", toName: "Ada Author" });
    expect(sent[0]!.text.split("\n")[0]).toBe("Hello Ada Author,");
  });
});

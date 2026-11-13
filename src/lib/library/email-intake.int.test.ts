import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emailMessage, notificationDelivery, person, source, submission } from "@/lib/db/schema";
import { createFilesystemStorage, originalKey, type Storage } from "@/lib/storage";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { pollMailbox, type EmailIntakeDeps, type IntakeMailbox, type MailboxMessage } from "./email-intake";
import { sha256Hex } from "./identify";

const testDb = connectTestDatabase();
const db = testDb.db;
const MAX = 5 * 1_048_576;
const fixture = async (name: string) => new Uint8Array(await readFile(path.resolve(import.meta.dirname, "../../../tests/fixtures/email", name)));

let directory: string;
let storage: Storage;
let seed: Awaited<ReturnType<typeof seedDirectory>>;

/** The IMAP mailbox as a fake: unseen messages, and what was marked done. */
class FakeMailbox implements IntakeMailbox {
  done_: number[] = [];
  closed = false;
  constructor(public messages: MailboxMessage[]) {}
  async *unseen(limit: number) {
    yield* this.messages.filter((m) => !this.done_.includes(m.uid)).slice(0, limit);
  }
  async done(uid: number) {
    this.done_.push(uid);
  }
  async close() {
    this.closed = true;
  }
}

const deps = (): EmailIntakeDeps => ({ db, storage, maxBytes: MAX, domains: ["example.org"] });
let uid = 0;
const message = async (name: string, overrides: Partial<MailboxMessage> = {}): Promise<MailboxMessage> => ({ uid: (uid += 1), source: await fixture(name), tooLarge: false, ...overrides });
const poll = (mailbox: FakeMailbox) => pollMailbox(deps(), async () => mailbox, () => new Date("2026-11-12T12:00:00Z"));

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "library-email-"));
  storage = createFilesystemStorage(directory);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  await testDb.close();
});

beforeEach(async () => {
  await testDb.reset();
  seed = await seedDirectory(db);
  await db.update(person).set({ workEmail: "ada@example.org" }).where(eq(person.id, seed.people.ada.id));
  await db.update(person).set({ workEmail: "Dan@example.org" }).where(eq(person.id, seed.people.dan.id));
  await db.update(person).set({ workEmail: "lea@example.org" }).where(eq(person.id, seed.people.lea.id));
});

describe("email intake", () => {
  it("adds the attached study and the link with the subject as the reason, and answers by email", async () => {
    const mailbox = new FakeMailbox([await message("forwarded-study.eml")]);
    expect(await poll(mailbox)).toEqual({ added: 1 });
    expect(mailbox.done_).toEqual([mailbox.messages[0]!.uid]);
    expect(mailbox.closed).toBe(true);

    const rows = await db.select().from(submission).innerJoin(source, eq(source.id, submission.sourceId));
    expect(rows.map((row) => [row.source.kind, row.submission.channel, row.submission.reason, row.submission.submitterId]).sort()).toEqual([
      ["file", "email", "Numbers on heat in small towns", seed.people.ada.id],
      ["link", "email", "Numbers on heat in small towns", seed.people.ada.id],
    ]);
    const pdf = new Uint8Array(await readFile(path.resolve(import.meta.dirname, "../../../tests/fixtures/files/study.pdf")));
    expect(await storage.exists(originalKey(sha256Hex(pdf)))).toBe(true);
    expect(rows.find((row) => row.source.kind === "link")!.source.normalizedUrl).toBe("https://example.com/articles/heat-small-towns");

    const [reply] = await db.select().from(notificationDelivery);
    expect(reply).toMatchObject({ event: "intake_reply", recipientId: seed.people.ada.id, channel: "email" });
    expect(reply!.message.subject).toBe("Library: Fwd: Numbers on heat in small towns");
    expect(reply!.message.text).toContain("Added to the library: 2 uploads");
    expect(reply!.message.text).toContain("numbers.xls: The library takes PDF, Word, Web page, Text files.");
    expect(reply!.message.text).not.toContain("logo.png");
    expect((await db.select().from(emailMessage))[0]).toMatchObject({ messageId: "<study-1@mail.example.org>", outcome: "added", personId: seed.people.ada.id, fromAddress: "ada@example.org" });
  });

  it("handles a message once, even when it arrives again", async () => {
    await poll(new FakeMailbox([await message("forwarded-study.eml")]));
    const again = new FakeMailbox([await message("forwarded-study.eml")]);
    expect(await poll(again)).toEqual({ duplicate: 1 });
    expect(again.done_).toHaveLength(1);
    expect(await db.select().from(submission)).toHaveLength(2);
    expect(await db.select().from(notificationDelivery)).toHaveLength(1);
  });

  it("refuses spoofed, automatic, and foreign mail without answering", async () => {
    const mailbox = new FakeMailbox([await message("spoofed.eml"), await message("auto-reply.eml"), await message("other-domain.eml")]);
    expect(await poll(mailbox)).toEqual({ unauthenticated: 1, automatic: 1, foreign_domain: 1 });
    expect(mailbox.done_).toHaveLength(3);
    expect(await db.select().from(submission)).toHaveLength(0);
    expect(await db.select().from(notificationDelivery)).toHaveLength(0);
    expect((await db.select({ outcome: emailMessage.outcome, personId: emailMessage.personId }).from(emailMessage)).map((row) => row.personId)).toEqual([null, null, null]);
  });

  it("takes the reason from the body of an HTML email with an empty subject", async () => {
    expect(await poll(new FakeMailbox([await message("html-only.eml")]))).toEqual({ added: 1 });
    const [row] = await db.select().from(submission);
    expect(row).toMatchObject({ submitterId: seed.people.dan.id, channel: "email", reason: "Good overview of municipal funding rules" });
  });

  it("answers an authenticated sender without access with a fixed text", async () => {
    await db.update(person).set({ hasAccess: false }).where(eq(person.id, seed.people.ada.id));
    expect(await poll(new FakeMailbox([await message("forwarded-study.eml")]))).toEqual({ no_access: 1 });
    expect(await db.select().from(submission)).toHaveLength(0);
    const [reply] = await db.select().from(notificationDelivery);
    expect(reply).toMatchObject({ channel: "email_address", channelId: "ada@example.org", recipientId: null, event: "intake_no_access" });
    expect(reply!.message.text).toContain("does not belong to anyone with access");
  });

  it("asks for a reason, and tells about messages over the size limit", async () => {
    const noSubject = new TextEncoder().encode(
      (await readFile(path.resolve(import.meta.dirname, "../../../tests/fixtures/email/html-only.eml"), "utf8"))
        .replace("<html-1@", "<html-2@")
        .replace("<p>Good overview of municipal funding rules</p>", "")
        .replace("The guide</a>", "https://funding.example.com/guide</a>"),
    );
    const tooLarge = await message("forwarded-study.eml", { tooLarge: true });
    expect(await poll(new FakeMailbox([{ uid: 99, source: noSubject, tooLarge: false }, tooLarge]))).toEqual({ no_reason: 1, too_large: 1 });
    const replies = (await db.select().from(notificationDelivery)).map((row) => row.message.text);
    expect(replies).toEqual(expect.arrayContaining([expect.stringMatching(/^Write one line on why/), expect.stringMatching(/larger than the library takes/)]));
    expect(await db.select().from(submission)).toHaveLength(0);
  });

  it("leaves a message unseen when handling it fails, and goes on with the next", async () => {
    const broken = new FakeMailbox([await message("forwarded-study.eml"), await message("html-only.eml")]);
    const failing: EmailIntakeDeps = { ...deps(), storage: { ...storage, exists: async () => false, put: async () => Promise.reject(new Error("storage down")) } };
    expect(await pollMailbox(failing, async () => broken)).toEqual({ failed: 1, added: 1 });
    expect(broken.done_).toEqual([broken.messages[1]!.uid]);
    expect(await db.select().from(emailMessage).where(eq(emailMessage.messageId, "<study-1@mail.example.org>"))).toHaveLength(0);
  });
});

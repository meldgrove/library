import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { notificationDelivery, person, slackEvent, source, submission } from "@/lib/db/schema";
import { createSlackIntakeClient } from "@/lib/slack/client";
import { createFilesystemStorage, originalKey, type Storage } from "@/lib/storage";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import type { fetchLink } from "./fetch-link";
import { sha256Hex } from "./identify";
import { processNextSlackEvent, recordSlackEvent, type SlackDirectMessage, type SlackIntakeDeps } from "./slack-intake";

const testDb = connectTestDatabase();
const db = testDb.db;
const MAX = 5 * 1_048_576;

let directory: string;
let storage: Storage;
let pdf: Uint8Array;
let seed: Awaited<ReturnType<typeof seedDirectory>>;

/** Slack's users.info as a fetch double: Slack user ID → email address, or an error. */
let slackUsers: Record<string, string | { error: string } | { status: number }>;
const downloads: { url: string; headers?: Record<string, string> }[] = [];

const fakeFetch: typeof fetch = async (input) => {
  const user = new URL(String(input)).searchParams.get("user") ?? "";
  const answer = slackUsers[user];
  if (answer && typeof answer === "object" && "status" in answer) return new Response("", { status: answer.status });
  const body =
    answer === undefined
      ? { ok: false, error: "user_not_found" }
      : typeof answer === "string"
        ? { ok: true, user: { id: user, is_email_confirmed: true, profile: { email: answer } } }
        : { ok: false, error: answer.error };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
};

const fakeDownload: typeof fetchLink = async (url, options) => {
  downloads.push({ url, headers: options.headers });
  const bytes = url.endsWith(".pdf") ? pdf : new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
  return { url, contentType: url.endsWith(".pdf") ? "application/pdf" : "image/png", bytes };
};

const deps = (): SlackIntakeDeps => ({ db, storage, slack: createSlackIntakeClient("xoxb-test", { fetchImpl: fakeFetch, download: fakeDownload }), maxBytes: MAX });

let eventCounter = 0;
const dm = (text: string, overrides: Partial<SlackDirectMessage> & { files?: SlackDirectMessage["message"]["files"] } = {}): SlackDirectMessage => ({
  eventId: overrides.eventId ?? `Ev${(eventCounter += 1)}`,
  slackUserId: overrides.slackUserId ?? "U0ADA",
  channelId: overrides.channelId ?? "D0ADA",
  message: { text, ts: "1700000000.000100", files: overrides.files ?? [] },
});

const repliesTo = async (personId: string) =>
  db.select().from(notificationDelivery).where(eq(notificationDelivery.recipientId, personId));

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "library-slack-"));
  storage = createFilesystemStorage(directory);
  pdf = new Uint8Array(await readFile(path.resolve(import.meta.dirname, "../../../tests/fixtures/files/study.pdf")));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  await testDb.close();
});

beforeEach(async () => {
  await testDb.reset();
  seed = await seedDirectory(db);
  await db.update(person).set({ workEmail: "ada@example.org" }).where(eq(person.id, seed.people.ada.id));
  await db.update(person).set({ workEmail: "lea@example.org" }).where(eq(person.id, seed.people.lea.id));
  slackUsers = { U0ADA: "Ada@Example.org", U0LEA: "lea@example.org", U0STRANGER: "stranger@example.org" };
  downloads.length = 0;
});

describe("Slack intake", () => {
  it("adds a link with the reason from the message and answers in the direct message", async () => {
    const message = dm("<https://example.org/heat-study?utm_source=slack|example.org/heat-study> - numbers on heat in small towns");
    await recordSlackEvent(db, message);
    expect(await processNextSlackEvent(deps())).toBe("added");

    const [added] = await db.select().from(submission).innerJoin(source, eq(source.id, submission.sourceId));
    expect(added!.submission).toMatchObject({ submitterId: seed.people.ada.id, channel: "slack", reason: "numbers on heat in small towns", status: "received" });
    expect(added!.source).toMatchObject({ kind: "link", normalizedUrl: "https://example.org/heat-study" });
    const replies = await repliesTo(seed.people.ada.id);
    expect(replies).toEqual([expect.objectContaining({ event: "intake_reply", channel: "slack", status: "pending" })]);
    expect(replies[0]!.message.text).toMatch(/^Added to the library: 1 upload\. The AI draft follows/);
    const [row] = await db.select().from(slackEvent).where(eq(slackEvent.eventId, message.eventId));
    expect(row).toMatchObject({ status: "done", outcome: "added", personId: seed.people.ada.id });
  });

  it("downloads a shared file with the bot token, stores it, and names the files it did not add", async () => {
    const message = dm("For the heat plan", {
      files: [
        { id: "F1", name: "study.pdf", mimetype: "application/pdf", size: pdf.byteLength, urlPrivateDownload: "https://files.slack.com/files-pri/T1-F1/download/study.pdf", mode: "hosted" },
        { id: "F2", name: "photo.png", mimetype: "image/png", size: 8, urlPrivateDownload: "https://files.slack.com/files-pri/T1-F2/download/photo.png", mode: "hosted" },
        { id: "F3", name: "huge.pdf", mimetype: "application/pdf", size: MAX + 1, urlPrivateDownload: "https://files.slack.com/files-pri/T1-F3/download/huge.pdf", mode: "hosted" },
      ],
    });
    await recordSlackEvent(db, message);
    expect(await processNextSlackEvent(deps())).toBe("added");

    expect(downloads).toEqual([{ url: "https://files.slack.com/files-pri/T1-F1/download/study.pdf", headers: { Authorization: "Bearer xoxb-test" } }]);
    const [added] = await db.select().from(submission).innerJoin(source, eq(source.id, submission.sourceId));
    expect(added!.source).toMatchObject({ kind: "file", fileName: "study.pdf", sha256: sha256Hex(pdf) });
    expect(added!.submission).toMatchObject({ channel: "slack", reason: "For the heat plan" });
    expect(await storage.exists(originalKey(sha256Hex(pdf)))).toBe(true);
    const [reply] = await repliesTo(seed.people.ada.id);
    expect(reply!.message.text).toContain("Not added:");
    expect(reply!.message.text).toContain("photo.png: The library takes PDF, Word, Web page, Text files.");
    expect(reply!.message.text).toContain("huge.pdf: the file is larger than 5 MB.");
  });

  it("asks for one line on why, and adds nothing without it", async () => {
    await recordSlackEvent(db, dm("<https://example.org/study>"));
    expect(await processNextSlackEvent(deps())).toBe("no_reason");
    expect(await db.select().from(submission)).toHaveLength(0);
    const [reply] = await repliesTo(seed.people.ada.id);
    expect(reply!.message.text).toMatch(/^Add one line on why/);
  });

  it("explains itself when the message has nothing to add", async () => {
    await recordSlackEvent(db, dm("hello there"));
    expect(await processNextSlackEvent(deps())).toBe("nothing_to_add");
    expect((await repliesTo(seed.people.ada.id))[0]!.message.text).toMatch(/^Send a link or a file/);
  });

  it("gives unknown people and people without access one fixed answer and no library data", async () => {
    await recordSlackEvent(db, dm("<https://example.org/a> why not", { slackUserId: "U0STRANGER", channelId: "D0STRANGER" }));
    await recordSlackEvent(db, dm("<https://example.org/b> why not", { slackUserId: "U0LEA", channelId: "D0LEA" }));
    await recordSlackEvent(db, dm("<https://example.org/c> why not", { slackUserId: "U0GONE", channelId: "D0GONE" }));
    expect(await processNextSlackEvent(deps())).toBe("no_access");
    expect(await processNextSlackEvent(deps())).toBe("no_access");
    expect(await processNextSlackEvent(deps())).toBe("no_access");

    expect(await db.select().from(submission)).toHaveLength(0);
    const posts = await db.select().from(notificationDelivery);
    expect(posts.map((post) => [post.channel, post.channelId, post.recipientId])).toEqual(
      expect.arrayContaining([
        ["slack_channel", "D0STRANGER", null],
        ["slack_channel", "D0LEA", null],
        ["slack_channel", "D0GONE", null],
      ]),
    );
    const texts = posts.map((post) => JSON.stringify(post.message));
    for (const text of texts) {
      expect(text).toContain("does not belong to anyone with access");
      expect(text).not.toMatch(/LIB-|Ada|Lea|uploads/);
    }
    const events = await db.select({ outcome: slackEvent.outcome, personId: slackEvent.personId }).from(slackEvent);
    expect(events.every((row) => row.outcome === "no_access" && row.personId === null)).toBe(true);
  });

  it("writes nothing when another worker took the message over during a slow download", async () => {
    slackUsers = { U0ADA: "ada@example.org" };
    await recordSlackEvent(db, dm("For the heat plan", { files: [{ id: "F1", name: "study.pdf", mimetype: "application/pdf", urlPrivateDownload: "https://files.slack.com/files-pri/T1-F1/study.pdf", size: 1_000 }] }));
    const slow: typeof fetchLink = async (url, options) => {
      // Meanwhile, another worker found the message stale and claimed it.
      await db.update(slackEvent).set({ attempts: sql`${slackEvent.attempts} + 1` });
      return fakeDownload(url, options);
    };
    const taken = { ...deps(), slack: createSlackIntakeClient("xoxb-test", { fetchImpl: fakeFetch, download: slow }) };
    expect(await processNextSlackEvent(taken)).toBe("taken_over");
    expect(await db.select().from(submission)).toHaveLength(0);
    expect(await repliesTo(seed.people.ada.id)).toHaveLength(0);
  });

  it("leaves the other worker's state alone when a taken-over message then fails", async () => {
    slackUsers = { U0ADA: "ada@example.org" };
    await recordSlackEvent(db, dm("For the heat plan", { files: [{ id: "F1", name: "study.pdf", mimetype: "application/pdf", urlPrivateDownload: "https://files.slack.com/files-pri/T1-F1/study.pdf", size: 1_000 }] }));
    const failing: typeof fetchLink = async () => {
      // Another worker claims the message and finishes it, then this download fails.
      await db.update(slackEvent).set({ attempts: sql`${slackEvent.attempts} + 1`, status: "done", outcome: "added" });
      throw new Error("connection reset");
    };
    const taken = { ...deps(), slack: createSlackIntakeClient("xoxb-test", { fetchImpl: fakeFetch, download: failing }) };
    expect(await processNextSlackEvent(taken)).toBe("taken_over");
    expect((await db.select().from(slackEvent))[0]).toMatchObject({ status: "done", outcome: "added" });
  });

  it("records an event Slack sends again only once", async () => {
    const message = dm("<https://example.org/once> worth reading");
    expect(await recordSlackEvent(db, message)).toBe(true);
    expect(await recordSlackEvent(db, message)).toBe(false);
    expect(await processNextSlackEvent(deps())).toBe("added");
    expect(await processNextSlackEvent(deps())).toBeNull();
    expect(await db.select().from(submission)).toHaveLength(1);
    expect(await repliesTo(seed.people.ada.id)).toHaveLength(1);
  });

  it("tries again when Slack cannot be reached, and stops at a permanent error", async () => {
    slackUsers.U0ADA = { status: 503 };
    const message = dm("<https://example.org/later> worth reading");
    await recordSlackEvent(db, message);
    const now = new Date();
    expect(await processNextSlackEvent(deps(), now)).toBe("retry");
    const [waiting] = await db.select().from(slackEvent).where(eq(slackEvent.eventId, message.eventId));
    expect(waiting).toMatchObject({ status: "received", attempts: 1 });
    expect(waiting!.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    expect(await processNextSlackEvent(deps(), now)).toBeNull();

    slackUsers.U0ADA = { error: "missing_scope" };
    expect(await processNextSlackEvent(deps(), new Date(now.getTime() + 2 * 60_000))).toBe("failed");
    const [failed] = await db.select().from(slackEvent).where(eq(slackEvent.eventId, message.eventId));
    expect(failed).toMatchObject({ status: "failed", lastError: "Slack users.info: missing_scope" });
    expect(await db.select().from(submission)).toHaveLength(0);
  });
});

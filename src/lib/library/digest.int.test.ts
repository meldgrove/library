import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvent, note, noteTag, notificationDelivery, person, source, tag, tagCluster, tagSubscription, team } from "@/lib/db/schema";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import type { NoteStatus, Visibility } from "./constants";
import { dispatchNext } from "@/lib/notifications/dispatch";
import { recordPersonalDigests, recordWeeklyDigests, setTeamDigestChannel } from "./digest";
import { saveTagSubscriptions, subscriptionOptions } from "./subscriptions";

const testDb = connectTestDatabase();
const db = testDb.db;
let seed: Awaited<ReturnType<typeof seedDirectory>>;

// Monday 16 November 2026, 09:00 in Amsterdam (the tests' server time zone).
const MONDAY = new Date("2026-11-16T08:00:00Z");
const daysBefore = (days: number) => new Date(MONDAY.getTime() - days * 24 * 60 * 60 * 1000);

let counter = 0;
async function makeNote(title: string, options: { visibility: Visibility; owner?: { id: string; teamId: string | null }; publishedAt?: Date; status?: NoteStatus; tagIds?: string[] }) {
  counter += 1;
  const owner = options.owner ?? seed.people.ada;
  const [src] = await db.insert(source).values({ kind: "link", url: `https://example.org/${counter}`, normalizedUrl: `https://example.org/${counter}` }).returning();
  const [created] = await db
    .insert(note)
    .values({
      sourceId: src!.id,
      ownerId: owner.id,
      teamId: owner.teamId,
      status: options.status ?? "published",
      visibility: options.visibility,
      title,
      core: `${title} in two sentences.`,
      publishedAt: options.status === "draft" ? null : (options.publishedAt ?? daysBefore(2)),
      quotes: [{ text: `A quote from ${title}` }],
    })
    .returning();
  for (const tagId of options.tagIds ?? []) await db.insert(noteTag).values({ noteId: created!.id, tagId });
  return created!;
}

const posts = async () => db.select().from(notificationDelivery).where(eq(notificationDelivery.event, "weekly_digest"));
const titlesIn = (post: { message: { sections?: { items: { title: string }[] }[] } }) => post.message.sections!.flatMap((section) => section.items.map((item) => item.title)).sort();

afterAll(() => testDb.close());
beforeEach(async () => {
  await testDb.reset();
  seed = await seedDirectory(db);
});

describe("weekly digest", () => {
  it("posts notes for everyone to the library's channel, and a team's notes to its own", async () => {
    const [cluster] = await db.insert(tagCluster).values({ name: "Climate" }).returning();
    await db.update(tag).set({ clusterId: cluster!.id }).where(eq(tag.id, seed.tags.budget.id));
    await makeNote("Engineering for all", { visibility: "all", tagIds: [seed.tags.budget.id] });
    await makeNote("Engineering team only", { visibility: "team" });
    await makeNote("Engineering private", { visibility: "private" });
    await makeNote("Engineering draft", { visibility: "all", status: "draft" });
    await makeNote("Operations for all", { visibility: "all", owner: seed.people.dan });
    await makeNote("Operations team only", { visibility: "team", owner: seed.people.dan });
    await makeNote("Too old", { visibility: "all", publishedAt: daysBefore(8) });
    await makeNote("Just inside", { visibility: "all", publishedAt: daysBefore(6.9) });
    await db.update(team).set({ digestSlackChannelId: "CENGINEERING" }).where(eq(team.id, seed.teams.tech.id));
    await db.update(team).set({ digestSlackChannelId: "COPERATIONS" }).where(eq(team.id, seed.teams.ops.id));
    // An inactive team gets no digest.
    await db.update(team).set({ digestSlackChannelId: "CARCHIVE" }).where(eq(team.id, seed.teams.archive.id));

    expect(await recordWeeklyDigests(db, MONDAY, { slackChannelId: "CLIBRARY" })).toEqual({ posted: 3, empty: 0 });
    const byChannel: Record<string, typeof notificationDelivery.$inferSelect> = Object.fromEntries((await posts()).map((post) => [post.channelId!, post]));
    expect(Object.keys(byChannel).sort()).toEqual(["CENGINEERING", "CLIBRARY", "COPERATIONS"]);
    expect(titlesIn(byChannel.CLIBRARY!)).toEqual(["Engineering for all", "Just inside", "Operations for all"]);
    expect(titlesIn(byChannel.CENGINEERING!)).toEqual(["Engineering for all", "Engineering team only", "Just inside"]);
    expect(titlesIn(byChannel.COPERATIONS!)).toEqual(["Operations for all", "Operations team only"]);
    expect(byChannel.CLIBRARY!.message.sections!.map((section) => section.heading)).toEqual(["Climate", "Other"]);
    expect(byChannel.CENGINEERING!.message.text).toContain("by Engineering");
    expect(byChannel.CLIBRARY!).toMatchObject({ channel: "slack_channel", recipientId: null, deliveryKey: "weekly_digest:2026-W47:all:CLIBRARY" });
    for (const post of Object.values(byChannel)) expect(JSON.stringify(post.message)).not.toContain("private");
  });

  it("posts once per week, and again the next week", async () => {
    await makeNote("Fresh", { visibility: "all" });
    expect((await recordWeeklyDigests(db, MONDAY, { slackChannelId: "CLIBRARY" })).posted).toBe(1);
    // A retried job in the same week records nothing new.
    expect((await recordWeeklyDigests(db, new Date(MONDAY.getTime() + 60 * 60_000), { slackChannelId: "CLIBRARY" })).posted).toBe(0);
    await makeNote("Next week", { visibility: "all", publishedAt: new Date(MONDAY.getTime() + 2 * 24 * 60 * 60_000) });
    expect((await recordWeeklyDigests(db, new Date(MONDAY.getTime() + 7 * 24 * 60 * 60_000), { slackChannelId: "CLIBRARY" })).posted).toBe(1);
    const keys = (await posts()).map((post) => post.deliveryKey).sort();
    expect(keys).toEqual(["weekly_digest:2026-W47:all:CLIBRARY", "weekly_digest:2026-W48:all:CLIBRARY"]);
  });

  it("skips channels without new notes and posts nothing without channels", async () => {
    await makeNote("Team only", { visibility: "team" });
    expect(await recordWeeklyDigests(db, MONDAY, {})).toEqual({ posted: 0, empty: 0 });
    expect(await recordWeeklyDigests(db, MONDAY, { slackChannelId: "CLIBRARY" })).toEqual({ posted: 0, empty: 1 });
    expect(await posts()).toHaveLength(0);
  });
});

describe("sending a digest", () => {
  const sent: { channel: string; text: string }[] = [];
  const transports = {
    baseUrl: "https://library.example",
    slack: { mode: "live" as const, lookupUserByEmail: async () => null, postMessage: async (channel: string, text: string) => void sent.push({ channel, text }) },
  };

  it("leaves out notes that became private or moved to a team after the digest was recorded", async () => {
    sent.length = 0;
    const kept = await makeNote("Kept", { visibility: "all" });
    const hidden = await makeNote("Hidden", { visibility: "all" });
    const narrowed = await makeNote("Narrowed", { visibility: "all" });
    await recordWeeklyDigests(db, MONDAY, { slackChannelId: "CLIBRARY" });
    await db.update(note).set({ visibility: "private" }).where(eq(note.id, hidden.id));
    await db.update(note).set({ visibility: "team" }).where(eq(note.id, narrowed.id));
    expect(await dispatchNext(db, transports, MONDAY)).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Kept");
    expect(sent[0]!.text).not.toContain("Hidden");
    expect(sent[0]!.text).not.toContain("Narrowed");
    expect(sent[0]!.text).toContain("1 new note was published");
    expect(kept.id).toBeTruthy();
  });

  it("is not sent when none of its notes may go out any more", async () => {
    sent.length = 0;
    const only = await makeNote("Only", { visibility: "all" });
    await recordWeeklyDigests(db, MONDAY, { slackChannelId: "CLIBRARY" });
    await db.delete(noteTag);
    await db.update(note).set({ status: "draft" }).where(eq(note.id, only.id));
    expect(await dispatchNext(db, transports, MONDAY)).toBe("skipped");
    expect(sent).toHaveLength(0);
  });
});

describe("email newsletter", () => {
  it("emails notes for everyone to the list once a week", async () => {
    await makeNote("For all", { visibility: "all" });
    await makeNote("Team only", { visibility: "team" });
    await makeNote("Private", { visibility: "private" });
    expect(await recordWeeklyDigests(db, MONDAY, { emailTo: "all-staff@example.org" })).toEqual({ posted: 1, empty: 0 });
    expect((await recordWeeklyDigests(db, MONDAY, { emailTo: "all-staff@example.org" })).posted).toBe(0);
    const [email] = await posts();
    expect(email).toMatchObject({ channel: "email_address", channelId: "all-staff@example.org", recipientId: null, deliveryKey: "weekly_digest:2026-W47:all:all-staff@example.org" });
    expect(titlesIn(email!)).toEqual(["For all"]);
    expect(email!.message.footer).toBe("The library sends this digest every Monday to all-staff@example.org.");
  });
});

describe("sending a personal digest or the newsletter", () => {
  it("rebuilds them before sending, leaving out notes the reader may no longer see", async () => {
    const emails: { to: string; text: string }[] = [];
    const transports = {
      baseUrl: "https://library.example",
      email: { mode: "live" as const, kind: "test", send: async (email: { to: string; text: string }) => void emails.push(email) },
    };
    const followed = seed.tags.budget.id;
    await db.update(person).set({ workEmail: "dan@example.org" }).where(eq(person.id, seed.people.dan.id));
    await makeNote("Still open", { visibility: "all", tagIds: [followed] });
    const closed = await makeNote("Closed later", { visibility: "all", tagIds: [followed] });
    await saveTagSubscriptions(db, seed.people.dan.id, [followed]);
    await recordPersonalDigests(db, MONDAY);
    await recordWeeklyDigests(db, MONDAY, { emailTo: "staff@example.org" });
    await db.update(note).set({ visibility: "private" }).where(eq(note.id, closed.id));
    while (await dispatchNext(db, transports, MONDAY)) {
      // Send everything due.
    }
    expect(emails.map((e) => e.to).sort()).toEqual(["dan@example.org", "staff@example.org"]);
    for (const email of emails) {
      expect(email.text).toContain("Still open");
      expect(email.text).not.toContain("Closed later");
    }
  });
});

describe("personal digests", () => {
  const digestOf = async (personId: string) =>
    (await db.select().from(notificationDelivery).where(eq(notificationDelivery.recipientId, personId))).filter((d) => d.event === "personal_digest");

  it("lists new notes with a followed tag that the person may see", async () => {
    const followed = seed.tags.budget.id;
    const other = seed.tags.tools.id;
    const dan = seed.people.dan; // Operations
    await makeNote("Engineering for all", { visibility: "all", tagIds: [followed] });
    await makeNote("Engineering team", { visibility: "team", tagIds: [followed] });
    await makeNote("Operations team", { visibility: "team", owner: dan, tagIds: [followed] });
    await makeNote("Dan's private", { visibility: "private", owner: dan, tagIds: [followed] });
    await makeNote("Ada's private", { visibility: "private", tagIds: [followed] });
    await makeNote("Draft", { visibility: "all", status: "draft", tagIds: [followed] });
    await makeNote("Other tag", { visibility: "all", tagIds: [other] });
    await makeNote("Last month", { visibility: "all", publishedAt: daysBefore(30), tagIds: [followed] });
    await saveTagSubscriptions(db, dan.id, [followed]);
    await saveTagSubscriptions(db, seed.people.amy.id, [followed]);
    // Lea follows the tag but has no access; Ada follows only a tag without new notes.
    await db.insert(tagSubscription).values({ personId: seed.people.lea.id, tagId: followed });
    const [unused] = await db.insert(tag).values({ name: "Unused" }).returning();
    await saveTagSubscriptions(db, seed.people.ada.id, [unused!.id]);

    expect(await recordPersonalDigests(db, MONDAY)).toBe(2);
    const [danDigest] = await digestOf(dan.id);
    expect(danDigest).toMatchObject({ channel: "email", deliveryKey: `personal_digest:2026-W47:${dan.id}` });
    // Not Engineering's team note, not someone else's private note, and not his own notes.
    expect(titlesIn(danDigest!)).toEqual(["Engineering for all"]);
    expect(danDigest!.message.footer).toBe("You get this email because you follow these tags in the library: Budget. Change them under Settings.");
    // Stewards see team notes of every team, but never someone else's private notes.
    const [amyDigest] = await digestOf(seed.people.amy.id);
    expect(titlesIn(amyDigest!)).toEqual(["Engineering for all", "Engineering team", "Operations team"]);
    expect(await digestOf(seed.people.lea.id)).toHaveLength(0);

    // Once per week.
    expect(await recordPersonalDigests(db, new Date(MONDAY.getTime() + 60_000))).toBe(2);
    expect(await db.select().from(notificationDelivery)).toHaveLength(2);
  });

  it("sends nothing to people without new notes on their tags", async () => {
    await makeNote("Other tag", { visibility: "all", tagIds: [seed.tags.tools.id] });
    await saveTagSubscriptions(db, seed.people.dan.id, [seed.tags.budget.id]);
    expect(await recordPersonalDigests(db, MONDAY)).toBe(0);
    expect(await db.select().from(notificationDelivery)).toHaveLength(0);
  });
});

describe("tag subscriptions", () => {
  it("replaces the followed tags and refuses inactive or unknown ones", async () => {
    const ada = seed.people.ada.id;
    await saveTagSubscriptions(db, ada, [seed.tags.budget.id, seed.tags.tools.id]);
    expect((await subscriptionOptions(db, ada)).followed.sort()).toEqual([seed.tags.budget.id, seed.tags.tools.id].sort());
    await saveTagSubscriptions(db, ada, [seed.tags.tools.id]);
    expect((await subscriptionOptions(db, ada)).followed).toEqual([seed.tags.tools.id]);
    await expect(saveTagSubscriptions(db, ada, [seed.tags.old.id])).rejects.toThrow(/Choose tags from the list/);
    await expect(saveTagSubscriptions(db, ada, ["00000000-0000-4000-8000-000000000000"])).rejects.toThrow(/Choose tags from the list/);
    // A followed tag that a steward deactivates stays followed, and listed.
    await db.update(tag).set({ isActive: false }).where(eq(tag.id, seed.tags.tools.id));
    await saveTagSubscriptions(db, ada, [seed.tags.tools.id]);
    const options = await subscriptionOptions(db, ada);
    expect(options.tagGroups.flatMap((group) => group.tags.map((t) => t.name)).sort()).toEqual(["Budget", "Tools"]);
    await saveTagSubscriptions(db, ada, []);
    expect((await subscriptionOptions(db, ada)).followed).toEqual([]);
    expect(await db.select().from(person).where(eq(person.id, ada))).toHaveLength(1);
  });
});

describe("setTeamDigestChannel", () => {
  it("lets stewards set and remove a team's channel, with an audit event", async () => {
    await setTeamDigestChannel(db, seed.actors.amy, seed.teams.tech.id, "C0123456789");
    expect((await db.select().from(team).where(eq(team.id, seed.teams.tech.id)))[0]!.digestSlackChannelId).toBe("C0123456789");
    await setTeamDigestChannel(db, seed.actors.amy, seed.teams.tech.id, null);
    expect((await db.select().from(team).where(eq(team.id, seed.teams.tech.id)))[0]!.digestSlackChannelId).toBeNull();
    const events = await db.select().from(auditEvent).where(eq(auditEvent.action, "team.digest_channel_changed"));
    expect(events.map((event) => event.payload)).toEqual([
      { from: null, to: "C0123456789" },
      { from: "C0123456789", to: null },
    ]);
  });

  it("refuses other people and channel names", async () => {
    await expect(setTeamDigestChannel(db, seed.actors.ada, seed.teams.tech.id, "C0123456789")).rejects.toThrow(/Only stewards/);
    await expect(setTeamDigestChannel(db, seed.actors.amy, seed.teams.tech.id, "#climate")).rejects.toThrow(/Slack channel ID/);
  });
});

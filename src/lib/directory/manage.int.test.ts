import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { auditEvent, authAccount, authSession, authUser, person, team } from "@/lib/db/schema";
import { CommandError, type Actor } from "@/lib/commands";
import {
  createTeam,
  invitePerson,
  renameTeam,
  savePreferences,
  setPersonAccess,
  setPersonRole,
  setTeamActive,
  updatePerson,
} from "./manage";
import { listPeople, listTeams } from "./queries";
import { invitePersonSchema, preferencesSchema } from "./schemas";

const testDb = connectTestDatabase();
const MANUAL = { editable: true };
const KEYCLOAK = { editable: false };
const { db } = testDb;
let seed: Awaited<ReturnType<typeof seedDirectory>>;
let amy: Actor;
let ada: Actor;

beforeEach(async () => {
  await testDb.reset();
  seed = await seedDirectory(db);
  amy = seed.actors.amy;
  ada = seed.actors.ada;
});
afterAll(() => testDb.close());

const invite = (overrides: Record<string, string> = {}) =>
  invitePersonSchema.parse({ email: "New.Person@Example.org", name: "New Person", teamId: seed.teams.ops.id, ...overrides });

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CommandError);
  return error as CommandError;
}

async function personRow(id: string) {
  const [row] = await db.select().from(person).where(eq(person.id, id));
  return row!;
}

describe("people of the manual directory", () => {
  it("invites a person with access, a lower-cased email, and an audit event", async () => {
    const created = await invitePerson(db, MANUAL, amy, invite({ role: "admin" }));
    expect(await personRow(created.id)).toMatchObject({
      displayName: "New Person",
      workEmail: "new.person@example.org",
      teamId: seed.teams.ops.id,
      hasAccess: true,
      role: "admin",
      oidcSubject: null,
      externalId: null,
    });
    const [event] = await db.select().from(auditEvent);
    expect(event).toMatchObject({ actorId: amy.personId, action: "person.invited" });
  });

  it("refuses non-admins, a known email, and an inactive team", async () => {
    expect((await rejection(invitePerson(db, MANUAL, ada, invite()))).code).toBe("forbidden");
    await invitePerson(db, MANUAL, amy, invite());
    expect((await rejection(invitePerson(db, MANUAL, amy, invite({ email: "NEW.PERSON@example.org" })))).fieldErrors.email).toBe(
      "This person already has access.",
    );
    expect((await rejection(invitePerson(db, MANUAL, amy, invite({ email: "x@example.org", teamId: seed.teams.archive.id })))).fieldErrors.teamId).toBe(
      "Choose an active team.",
    );
  });

  it("changes name and team", async () => {
    await updatePerson(db, MANUAL, amy, seed.people.ada.id, { name: "Ada A. Author", teamId: null });
    expect(await personRow(seed.people.ada.id)).toMatchObject({ displayName: "Ada A. Author", teamId: null });
  });

  it("takes access away, ends the sessions, and gives it back without admin rights", async () => {
    await setPersonRole(db, MANUAL, amy, seed.people.dan.id, "admin");
    await db.insert(authUser).values({ id: "u-dan", name: "Dan", email: "dan@example.org" });
    await db.insert(authAccount).values({ id: "a-dan", accountId: "sub-dan", providerId: "oidc", userId: "u-dan" });
    const expiresAt = new Date(Date.now() + 86_400_000);
    await db.insert(authSession).values({ id: "s-dan", token: "t-dan", userId: "u-dan", oidcSubject: "sub-dan", expiresAt });
    // Another `sub` with the same email, linked to the same Better Auth user.
    await db.insert(authSession).values({ id: "s-other", token: "t-other", userId: "u-dan", oidcSubject: "sub-other", expiresAt });

    await setPersonAccess(db, MANUAL, amy, seed.people.dan.id, false);
    expect(await personRow(seed.people.dan.id)).toMatchObject({ hasAccess: false, role: "member" });
    expect((await db.select().from(authSession)).map((s) => s.id)).toEqual(["s-other"]);

    await setPersonAccess(db, MANUAL, amy, seed.people.dan.id, true);
    expect(await personRow(seed.people.dan.id)).toMatchObject({ hasAccess: true, role: "member" });
    const actions = (await db.select().from(auditEvent)).map((e) => e.action);
    expect(actions).toEqual(["person.role_changed", "person.access_revoked", "person.access_granted"]);
  });

  it("keeps at least one admin, and nobody can lock themselves out", async () => {
    expect((await rejection(setPersonAccess(db, MANUAL, amy, amy.personId, false))).message).toBe("You cannot take away your own access.");
    expect((await rejection(setPersonRole(db, MANUAL, amy, amy.personId, "member"))).message).toMatch(/last admin/);
    await setPersonRole(db, MANUAL, amy, seed.people.dan.id, "admin");
    await setPersonRole(db, MANUAL, amy, amy.personId, "member");
    expect(await personRow(amy.personId)).toMatchObject({ role: "member", hasAccess: true });
  });

  it("runs changes that may remove the last admin one after another", async () => {
    await setPersonRole(db, MANUAL, amy, seed.people.dan.id, "admin");
    // Another transaction is checking the admin count right now.
    const other = await testDb.pool.connect();
    try {
      await other.query("begin");
      await other.query("select pg_advisory_xact_lock(hashtext('library:admins'))");
      let finished = false;
      const demotion = setPersonRole(db, MANUAL, amy, amy.personId, "member").then(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(finished).toBe(false);
      await other.query("commit");
      await demotion;
      expect(finished).toBe(true);
    } finally {
      other.release();
    }
  });

  it("makes a person a maintainer, which lets them change no people", async () => {
    await setPersonRole(db, MANUAL, amy, seed.people.dan.id, "maintainer");
    expect(await personRow(seed.people.dan.id)).toMatchObject({ role: "maintainer" });
    const [event] = await db.select().from(auditEvent);
    expect(event).toMatchObject({ action: "person.role_changed", payload: { personId: seed.people.dan.id, name: "Dan Decider", from: "member", to: "maintainer" } });
    const dan = { personId: seed.people.dan.id, role: "maintainer" as const };
    expect((await rejection(setPersonRole(db, MANUAL, dan, seed.people.ada.id, "maintainer"))).code).toBe("forbidden");
  });

  it("makes only people with access admins", async () => {
    expect((await rejection(setPersonRole(db, MANUAL, amy, seed.people.lea.id, "admin"))).message).toBe("Give this person access first.");
  });

  it("changes nobody while people and teams come from Keycloak", async () => {
    const refused = "People and teams come from Keycloak. Change them there.";
    expect(await rejection(setPersonAccess(db, KEYCLOAK, amy, seed.people.dan.id, false))).toMatchObject({ code: "forbidden", message: refused });
    expect((await rejection(updatePerson(db, KEYCLOAK, amy, seed.people.dan.id, { name: "X", teamId: null }))).code).toBe("forbidden");
    expect((await rejection(invitePerson(db, KEYCLOAK, amy, invite()))).code).toBe("forbidden");
    expect((await rejection(createTeam(db, KEYCLOAK, amy, { name: "Finance" }))).code).toBe("forbidden");
    expect((await rejection(setTeamActive(db, KEYCLOAK, amy, seed.teams.tech.id, false))).code).toBe("forbidden");
    expect(await db.select().from(auditEvent)).toHaveLength(0);
  });

  it("changes people and teams synced from Keycloak once the directory is manual", async () => {
    const [synced] = await db.insert(person).values({ externalId: "kc-1", oidcSubject: "kc-1", displayName: "Synced", hasAccess: true }).returning();
    const [syncedTeam] = await db.insert(team).values({ externalId: "kc-team", name: "Synced Team" }).returning();
    await updatePerson(db, MANUAL, amy, synced!.id, { name: "Renamed", teamId: syncedTeam!.id });
    await setPersonAccess(db, MANUAL, amy, synced!.id, false);
    await renameTeam(db, MANUAL, amy, syncedTeam!.id, { name: "Renamed Team" });
    await setTeamActive(db, MANUAL, amy, syncedTeam!.id, false);
    expect(await personRow(synced!.id)).toMatchObject({ displayName: "Renamed", teamId: syncedTeam!.id, hasAccess: false, externalId: "kc-1" });
    const [teamRow] = await db.select().from(team).where(eq(team.id, syncedTeam!.id));
    expect(teamRow).toMatchObject({ name: "Renamed Team", isActive: false, externalId: "kc-team" });
  });

  it("saves a person's own time zone and date format", async () => {
    await savePreferences(db, ada.personId, preferencesSchema.parse({ timeZone: "America/New_York", dateFormat: "MM/DD/YYYY" }));
    expect(await personRow(ada.personId)).toMatchObject({ timeZone: "America/New_York", dateFormat: "MM/DD/YYYY" });
    await savePreferences(db, ada.personId, preferencesSchema.parse({ timeZone: "", dateFormat: "DD.MM.YYYY" }));
    expect(await personRow(ada.personId)).toMatchObject({ timeZone: null, dateFormat: "DD.MM.YYYY" });
    expect(preferencesSchema.safeParse({ timeZone: "Mars/Olympus", dateFormat: "DD.MM.YYYY" }).success).toBe(false);
  });
});

describe("teams of the manual directory", () => {
  it("creates, renames, and deactivates a team with unique names", async () => {
    const created = await createTeam(db, MANUAL, amy, { name: "Finance" });
    expect((await rejection(createTeam(db, MANUAL, amy, { name: "finance" }))).fieldErrors.name).toBe("A team with this name already exists.");
    await renameTeam(db, MANUAL, amy, created.id, { name: "Finance & Legal" });
    await setTeamActive(db, MANUAL, amy, created.id, false);
    const [row] = await db.select().from(team).where(eq(team.id, created.id));
    expect(row).toMatchObject({ name: "Finance & Legal", isActive: false });
    expect((await db.select().from(auditEvent)).map((e) => e.action)).toEqual(["team.created", "team.renamed", "team.deactivated"]);
    expect((await rejection(createTeam(db, MANUAL, ada, { name: "Other" }))).code).toBe("forbidden");
  });

  it("lists teams with the number of people with access in each", async () => {
    const teams = await listTeams(db);
    expect(teams.map((t) => [t.name, t.members, t.isActive])).toEqual([
      ["Engineering", 1, true],
      ["Operations", 2, true],
      ["Archive", 0, false],
    ]);
    const people = await listPeople(db);
    expect(people.at(-1)).toMatchObject({ displayName: "Lea Left", hasAccess: false, teamName: "Engineering", hasLoggedIn: true });
  });

  it("never deletes teams", async () => {
    await expect(db.delete(team).where(eq(team.id, seed.teams.archive.id))).rejects.toThrow();
  });
});

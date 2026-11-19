import { describe, expect, it } from "vitest";
import type { Role } from "@/lib/auth/roles";
import { directoryChange, personChanges, type Check } from "./rules";

const MANUAL = { editable: true };
const KEYCLOAK = { editable: false };
const admin = { personId: "me", role: "admin" as const };
const maintainer = { personId: "me", role: "maintainer" as const };
const member = { personId: "me", role: "member" as const };

const LAST_ADMIN = "This is the last admin. Make someone else an admin first.";
const allowed = (check: Check) => (check.ok ? "ok" : check.reason);

describe("directoryChange", () => {
  it("lets admins change people and teams only in a directory managed in the library", () => {
    expect(directoryChange(MANUAL, admin)).toEqual({ ok: true });
    expect(directoryChange(MANUAL, member)).toEqual({ ok: false, reason: "Only admins can manage people and teams.", forbidden: true });
    expect(directoryChange(MANUAL, maintainer)).toEqual({ ok: false, reason: "Only admins can manage people and teams.", forbidden: true });
    expect(directoryChange(KEYCLOAK, admin)).toEqual({
      ok: false,
      reason: "People and teams come from Keycloak. Change them there.",
      forbidden: true,
    });
  });
});

describe("personChanges", () => {
  // [case, target, admins with access, edit, access, admin]
  const cases: [string, { id: string; hasAccess: boolean; role: Role }, number, string, string, string][] = [
    ["a person with access", { id: "p", hasAccess: true, role: "member" }, 1, "ok", "ok", "ok"],
    ["a person without access", { id: "p", hasAccess: false, role: "member" }, 1, "ok", "ok", "Give this person access first."],
    ["another admin", { id: "p", hasAccess: true, role: "admin" }, 2, "ok", "ok", "ok"],
    ["myself, one of two admins", { id: "me", hasAccess: true, role: "admin" }, 2, "ok", "You cannot take away your own access.", "ok"],
    ["myself, the last admin", { id: "me", hasAccess: true, role: "admin" }, 1, "ok", "You cannot take away your own access.", LAST_ADMIN],
    ["the last admin, someone else", { id: "p", hasAccess: true, role: "admin" }, 1, "ok", LAST_ADMIN, LAST_ADMIN],
  ];

  it.each(cases)("%s", (_, target, admins, edit, access, adminRights) => {
    const changes = personChanges(MANUAL, admin, target, admins);
    expect([allowed(changes.edit), allowed(changes.access), allowed(changes.role)]).toEqual([edit, access, adminRights]);
  });

  it("refuses everything to non-admins and while people come from Keycloak", () => {
    const target = { id: "p", hasAccess: true, role: "member" as const };
    for (const [directory, actor] of [
      [KEYCLOAK, admin],
      [MANUAL, maintainer],
      [MANUAL, member],
    ] as const) {
      const changes = personChanges(directory, actor, target, 2);
      expect([changes.edit, changes.access, changes.role].every((check) => !check.ok && check.forbidden)).toBe(true);
    }
  });

  it("marks a refusal about this person as invalid input, not as forbidden", () => {
    expect(personChanges(MANUAL, admin, { id: "me", hasAccess: true, role: "admin" }, 1).role).toEqual({ ok: false, reason: LAST_ADMIN });
  });
});

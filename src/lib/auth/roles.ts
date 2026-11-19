/*
 * The roles in the library, each with the rights of the one before it. No
 * imports, so the schema can use them.
 *
 * - Members add sources, review and publish their own drafts, and read.
 * - Maintainers look after the content: they see and edit drafts that are
 *   not private, check and delete notes, decide uploads on hold, and keep the
 *   taxonomy.
 * - Admins run the app: people and their roles, teams, the directory,
 *   notifications, and the webhook.
 */

export const ROLES = ["member", "maintainer", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  member: "Member",
  maintainer: "Maintainer",
  admin: "Admin",
};

/** What each role may do, next to the role choices. */
export const ROLE_HELP =
  "Members add sources and review their own drafts. Maintainers also look after the content: drafts, checks, uploads on hold, and the taxonomy. Admins also manage people, teams, and the app.";

/** Maintainers and admins look after the content. */
export const canMaintain = (role: Role): boolean => role === "maintainer" || role === "admin";

/** Only admins manage the app. */
export const canAdminister = (role: Role): boolean => role === "admin";

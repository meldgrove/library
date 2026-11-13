import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export const PASSWORD = "library-dev";

/** Signs in through the development Keycloak. */
export async function signIn(page: Page, username: string): Promise<void> {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/realms\/library\//);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
}

/** No WCAG 2.1 A/AA violations on the current page. */
export async function expectAccessible(page: Page): Promise<void> {
  // Next.js streams the title after the page; after a client-side navigation
  // axe could otherwise run before it is back. Every title ends in "Meldgrove Library".
  await expect(page).toHaveTitle(/Meldgrove Library$/);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** Collects Content Security Policy violations reported by the browser. */
export function collectCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text());
  });
  return violations;
}

/** A suffix that keeps titles unique across runs against the same database. */
export const runId = Date.now().toString(36);

/** Runs a query against the database of the app under test. Needs DATABASE_URL. */
export async function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

export interface Delivery {
  event: string;
  channel: string;
  status: string;
  recipient: string;
}

/** The notifications recorded for a note, with their status. */
export async function deliveries(noteNumber: number): Promise<Delivery[]> {
  return query<Delivery & Record<string, unknown>>(
    `select d.event, d.channel, d.status, p.display_name as recipient
       from notification_delivery d
       join person p on p.id = d.recipient_id
       join note n on n.id = d.note_id
      where n.number = $1
      order by d.created_at, p.display_name`,
    [noteNumber],
  );
}

/** The development Keycloak, administered with its bootstrap admin (compose.dev.yaml). */
const KEYCLOAK_URL = process.env.E2E_KEYCLOAK_URL ?? "http://localhost:8094";

async function keycloakAdmin(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: "admin" }),
  }).then(async (response) => ((await response.json()) as { access_token: string }).access_token);
  const response = await fetch(`${KEYCLOAK_URL}/admin/realms/library${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });
  if (!response.ok) throw new Error(`Keycloak ${init.method ?? "GET"} ${path}: HTTP ${response.status}`);
  return response;
}

/** Adds a user of the development realm to a group, or removes them from it. */
export async function setGroupMembership(username: string, groupPath: string, member: boolean): Promise<void> {
  const [user] = (await (await keycloakAdmin(`/users?exact=true&username=${encodeURIComponent(username)}`)).json()) as { id: string }[];
  const group = (await (await keycloakAdmin(`/group-by-path/${groupPath.replace(/^\//, "")}`)).json()) as { id: string };
  await keycloakAdmin(`/users/${user!.id}/groups/${group.id}`, { method: member ? "PUT" : "DELETE" });
}

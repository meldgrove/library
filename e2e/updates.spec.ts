import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

/*
 * The update button. There is no updater in these tests, so the browser's
 * requests to /api/admin/updates are answered here; the routes themselves are
 * tested in src/app/api/admin/updates/route.test.ts.
 */

function status(extra: Record<string, unknown> = {}) {
  return {
    updater: "0.2.0",
    mode: "host",
    channel: "stable",
    channelLocked: null,
    installed: "0.2.0",
    available: {
      version: "0.2.1",
      preview: false,
      publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      url: "https://github.com/meldgrove/library/releases/tag/v0.2.1",
      notes: ["Show who changed a note last", "Fix the sign-in loop behind some proxies"],
      changes: 2,
      installsAt: new Date(Date.now() + 86_400_000).toISOString(),
      failed: null,
    },
    attention: null,
    installing: null,
    last: null,
    checking: false,
    checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    error: null,
    automatic: true,
    cooldown: "3d",
    window: "02:00-05:00",
    timezone: "UTC",
    ...extra,
  };
}

const answer = (updater: unknown) => ({ app: { version: null }, reachable: true, updater, error: null });

async function fulfill(route: Route, code: number, body: unknown): Promise<void> {
  await route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(body) });
}

/** The updater accepts the installation and reports it installed at the second request after. */
async function fakeUpdater(page: Page): Promise<void> {
  let polls = -1;
  await page.route("**/api/admin/updates", async (route) => {
    if (polls < 0) return fulfill(route, 200, answer(status()));
    polls += 1;
    if (polls < 2) {
      return fulfill(route, 200, answer(status({ installing: { version: "0.2.1", startedAt: new Date().toISOString(), manual: true, stage: "pulling" } })));
    }
    return fulfill(route, 200, answer(status({ installed: "0.2.1", available: null, last: { version: "0.2.1", result: "installed", message: null, finishedAt: new Date().toISOString() } })));
  });
  await page.route("**/api/admin/updates/install", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ version: "0.2.1" });
    polls = 0;
    await fulfill(route, 202, answer(status({ installing: { version: "0.2.1", startedAt: new Date().toISOString(), manual: true, stage: "requested" } })));
  });
}

test("people who are not admins have no update button and no update routes", async ({ page }) => {
  await signIn(page, "erika");
  await expect(page.getByRole("heading", { name: "Library", level: 1 })).toBeVisible();
  await expect(page.locator("[data-update-state]")).toHaveCount(0);
  expect((await page.request.get("/api/admin/updates")).status()).toBe(404);
});

test("the update routes refuse requests from other sites", async ({ page }) => {
  await signIn(page, "adam");
  await expect(page.getByRole("heading", { name: "Library", level: 1 })).toBeVisible();
  const current = await page.request.get("/api/admin/updates");
  expect(current.status()).toBe(200);
  expect(typeof (await current.json()).reachable).toBe("boolean");
  const foreign = await page.request.post("/api/admin/updates/install", { data: { version: "0.2.1" }, headers: { origin: "https://evil.example" } });
  expect(foreign.status()).toBe(403);
});

test("an admin installs an available update from the header", async ({ page }) => {
  await fakeUpdater(page);
  await signIn(page, "adam");
  const button = page.getByRole("button", { name: "Update available · 0.2.1" });
  await expect(button).toBeVisible();

  await button.click();
  const popover = page.getByTestId("update-popover");
  await expect(popover).toContainText("Update available");
  await expect(popover.getByRole("listitem")).toHaveText(["Show who changed a note last", "Fix the sign-in loop behind some proxies"]);
  await expect(popover).toContainText("Installed: 0.2.0 · Stable");
  await expectAccessible(page);

  await popover.getByRole("button", { name: "Install now" }).click();
  const dialog = page.getByRole("dialog", { name: "Install 0.2.1 now?" });
  await expect(dialog).toContainText("Database changes run automatically.");
  await dialog.getByRole("button", { name: "Install" }).click();

  await expect(page.locator('[data-update-state="installing"]')).toBeVisible();
  const reload = page.waitForEvent("load");
  await expect(page.getByRole("status").filter({ hasText: "Updated to 0.2.1" })).toBeVisible();
  await reload;
  await expect(page.getByRole("button", { name: "Up to date · 0.2.1" })).toBeVisible();
});

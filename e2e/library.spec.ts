import path from "node:path";
import { expect, test } from "@playwright/test";
import { deliveries, expectAccessible, signIn } from "./helpers";

/*
 * An upload from the page to a draft note, through the running worker with
 * the fake AI model. The steps build on each other, so they run in order.
 */
test.describe.configure({ mode: "serial" });

const STUDY = path.resolve(import.meta.dirname, "../tests/fixtures/files/study.pdf");

test("an upload needs a reason and the confirmation of the rules", async ({ page }) => {
  await signIn(page, "erika");
  await page.getByRole("link", { name: "Add to library" }).first().click();
  await expect(page.getByRole("heading", { name: "Add to library", level: 1 })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("File", { exact: true }).setInputFiles(STUDY);
  // The form leaves the checks to the server, which refuses the missing fields.
  await page.getByRole("button", { name: "Add to library" }).click();
  await expect(page.getByText("Say in one line why this is useful.")).toBeVisible();
  await expect(page.getByText("Confirm that the upload follows the rules.")).toBeVisible();
});

test("a PDF becomes a draft note the uploader can open", async ({ page }) => {
  await signIn(page, "erika");
  await page.goto("/upload");
  await page.getByLabel("File", { exact: true }).setInputFiles(STUDY);
  await page.getByLabel("Why is it useful?").fill("Numbers on heat plans");
  await page.getByRole("checkbox", { name: "I confirm that this upload follows the rules above." }).check();
  await page.getByRole("button", { name: "Add to library" }).click();

  await expect(page).toHaveURL(/\/uploads\?added=1$/);
  await expect(page.getByRole("heading", { name: "My uploads", level: 1 })).toBeVisible();
  // The worker drafts within seconds with the fake model.
  const row = page.getByRole("row").filter({ hasText: "Numbers on heat plans" }).first();
  await expect(async () => {
    await page.reload();
    await expect(row).toContainText(/Drafted|Already in the library/, { timeout: 1_000 });
  }).toPass({ timeout: 60_000, intervals: [2_000] });
  await expectAccessible(page);

  await row.getByRole("link", { name: /LIB-\d+/ }).click();
  await expect(page.getByRole("heading", { name: "Municipal climate adaptation", level: 1 })).toBeVisible();
  await expect(page.getByText("Key points")).toBeVisible();
  await expect(page.getByRole("link", { name: /study\.pdf/ })).toHaveAttribute("href", /\/api\/originals\//);
  await expectAccessible(page);

  const number = Number(/\/n\/(\d+)$/.exec(page.url())![1]);
  expect((await deliveries(number)).map((d) => [d.event, d.recipient])).toContainEqual(["draft_ready", "Erika Employee"]);
});

test("a steward can open a draft that is not private", async ({ page }) => {
  await signIn(page, "erika");
  await page.goto("/uploads");
  const href = await page.getByRole("link", { name: /LIB-\d+/ }).first().getAttribute("href");
  await page.getByTestId("current-user").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, "adam");
  await expect(page.getByRole("heading", { name: "Library", level: 1 })).toBeVisible();
  // Stewards see drafts that are not private.
  expect((await page.goto(href!))?.status()).toBe(200);
});

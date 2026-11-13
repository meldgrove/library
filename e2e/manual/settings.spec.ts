import { expect, test } from "@playwright/test";
import { expectAccessible, runId, signIn } from "../helpers";

/* Personal digests, on the manual instance (its own database): a steward adds a tag, and follows it on Settings. */

test("a person follows a tag for the weekly email", async ({ page }) => {
  const tagName = `Heat ${runId}`;
  await signIn(page, "adam");
  await expect(page.getByRole("heading", { name: "Library", level: 1 })).toBeVisible();
  await page.goto("/admin/taxonomy");
  await page.getByLabel("Tag name").fill(tagName);
  await page.getByRole("button", { name: "Add tag" }).click();
  // The new tag's row: its name in an editable field.
  await expect(page.getByRole("textbox", { name: "Tag name" }).nth(1)).toHaveValue(tagName);

  await page.goto("/settings");
  const weekly = page.getByRole("region", { name: "Weekly email" });
  await expect(weekly.getByText("Tags you follow")).toBeVisible();
  await expectAccessible(page);
  await weekly.getByRole("checkbox", { name: tagName }).check();
  await weekly.getByRole("button", { name: "Save tags" }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("region", { name: "Weekly email" }).getByRole("checkbox", { name: tagName })).toBeChecked({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });

  await page.getByRole("region", { name: "Weekly email" }).getByRole("checkbox", { name: tagName }).uncheck();
  await page.getByRole("region", { name: "Weekly email" }).getByRole("button", { name: "Save tags" }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("region", { name: "Weekly email" }).getByRole("checkbox", { name: tagName })).not.toBeChecked({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
});

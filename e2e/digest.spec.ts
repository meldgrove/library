import { expect, test } from "@playwright/test";
import { expectAccessible, query, signIn } from "./helpers";

/* The weekly digest: a steward chooses the Slack channel of a team's digest. */

const channelOf = async (teamName: string) =>
  (await query<{ channel: string | null }>("select digest_slack_channel_id as channel from team where name = $1", [teamName]))[0]?.channel ?? null;

test("a steward sets the Slack channel for a team's weekly digest", async ({ page }) => {
  await signIn(page, "adam");
  await expect(page.getByRole("heading", { name: "Library", level: 1 })).toBeVisible();
  await page.goto("/admin/teams");
  const row = page.getByRole("row").filter({ hasText: "Engineering" });
  const field = row.getByLabel("Slack channel for the digest of Engineering");

  await field.fill("#engineering");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText("Enter a Slack channel ID such as C0123456789, or leave it empty.")).toBeVisible();
  await expectAccessible(page);

  await field.fill("c0engineer1");
  await row.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => channelOf("Engineering")).toBe("C0ENGINEER1");
  await page.reload();
  await expect(field).toHaveValue("C0ENGINEER1");

  await field.fill("");
  await row.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => channelOf("Engineering")).toBeNull();
});

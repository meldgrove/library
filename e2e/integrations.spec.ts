import { expect, test } from "@playwright/test";
import { expectAccessible, query, signIn } from "./helpers";

const KEY = "sk-ant-e2e-integrations-key-7d3f";

test("an admin sets up the AI model under Integrations: write only, with a hint", async ({ page }) => {
  // From a fresh setting, also on a retry.
  await query("delete from app_setting where key = 'integration.ai'");
  await signIn(page, "adam");
  await page.goto("/admin/integrations");
  await expect(page.getByRole("heading", { name: "Integrations", level: 1 })).toBeVisible();
  for (const name of ["AI model", "Email", "Slack", "Weekly digest", "Webhook", "Email intake"]) {
    await expect(page.getByRole("heading", { name, level: 2, exact: true })).toBeVisible();
  }
  const ai = page.getByRole("form", { name: "AI model" });
  const state = page.getByRole("heading", { name: "AI model", level: 2 }).locator("..");
  await expect(state).toContainText("Off");
  // The test worker drafts with the fake model and says so.
  await expect(ai).toContainText("AI_PROVIDER=fake is set");
  await expectAccessible(page);

  // A key without a model is refused with the field's message.
  await ai.getByLabel("Provider").selectOption("anthropic");
  await ai.getByLabel("API key").fill(KEY);
  await ai.getByLabel("Model").fill("");
  await ai.getByRole("button", { name: "Save" }).click();
  await expect(ai).toContainText("is required");

  await ai.getByLabel("Model").fill("claude-opus-5-5");
  await ai.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("AI model saved.")).toBeVisible();
  await expect(state).toContainText("Set up");

  await page.reload();
  const saved = page.getByRole("form", { name: "AI model" });
  await expect(saved).toContainText("…7d3f");
  expect(await page.content()).not.toContain(KEY);
  const [row] = await query<{ value: string }>("select value::text from app_setting where key = 'integration.ai'");
  expect(row?.value).not.toContain(KEY);
  const [audit] = await query<{ action: string }>("select action from audit_event where subject_type = 'setting' order by created_at desc limit 1");
  expect(audit?.action).toBe("setting.changed");

  // Switched off again, so the rest of the suite drafts as before.
  await saved.getByLabel("Provider").selectOption("");
  await saved.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("AI model saved.")).toBeVisible();
  await expect(state).toContainText("Off");
});

test("the webhook's URL is write only: the page shows its server, and removing it turns the webhook off", async ({ page }) => {
  await query("delete from app_setting where key = 'integration.webhook'");
  await signIn(page, "adam");
  await page.goto("/admin/integrations");
  const webhook = page.getByRole("form", { name: "Webhook" });
  const state = page.getByRole("heading", { name: "Webhook", level: 2 }).locator("..");
  await webhook.getByLabel("URL").fill("http://127.0.0.1:9/e2e-path-token?key=e2e-query-token");
  await webhook.getByLabel("Signing secret").fill("e2e-webhook-secret-0123456789");
  await webhook.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Webhook saved.")).toBeVisible();
  await expect(state).toContainText("Set up");

  await page.reload();
  await expect(webhook).toContainText("Stored (http://127.0.0.1:9)");
  expect(await page.content()).not.toContain("e2e-path-token");
  const [row] = await query<{ value: string }>("select value::text from app_setting where key = 'integration.webhook'");
  expect(row?.value).not.toMatch(/e2e-(path|query)-token|e2e-webhook-secret/);
  await expectAccessible(page);

  await webhook.getByRole("button", { name: "Remove" }).first().click();
  await webhook.getByRole("button", { name: "Save" }).click();
  await expect(state).toContainText("Off");
});

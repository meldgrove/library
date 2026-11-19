import { expect, test } from "@playwright/test";
import { query, runId, signIn } from "./helpers";

test("a steward can resolve visible tag proposals while private ones stay hidden", async ({ page }) => {
  const visibleTitle = `Shared note ${runId}`;
  const privateTitle = `Private note ${runId}`;
  const proposal = `Heat islands ${runId}`;

  await query(
    `with author as (
       insert into person (display_name) values ('Example Author') returning id
     ), originals as (
       insert into source (kind, url) values ('link', $4), ('link', $5) returning id, url
     ), notes as (
       insert into note (source_id, owner_id, visibility, title, core)
       select originals.id, author.id, case when url = $4 then 'all' else 'private' end,
              case when url = $4 then $1 else $2 end, 'Summary'
       from originals cross join author returning id
     )
     insert into tag_proposal (note_id, name) select id, $3 from notes`,
    [visibleTitle, privateTitle, proposal, `https://example.org/shared-${runId}`, `https://example.org/private-${runId}`],
  );

  await signIn(page, "adam");
  await expect(page.getByRole("heading", { name: "Library", level: 1 })).toBeVisible();
  await page.goto("/admin/taxonomy");
  const proposals = page.getByRole("region", { name: "Tag proposals" });
  const shared = proposals.getByRole("row").filter({ hasText: visibleTitle });
  await expect(shared).toContainText(proposal);
  await expect(proposals.getByText(privateTitle, { exact: false })).toHaveCount(0);
  await shared.getByRole("button", { name: "Reject" }).click();
  await expect(shared).toHaveCount(0);

  expect(await query(`
    select n.visibility, p.status from tag_proposal p join note n on n.id = p.note_id
    where p.name = $1 order by n.visibility`, [proposal])).toEqual([
    { visibility: "all", status: "rejected" },
    { visibility: "private", status: "pending" },
  ]);
});

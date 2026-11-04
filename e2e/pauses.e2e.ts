import { expect, test } from "@playwright/test";
import { seed, signIn } from "./fixtures";

/** A local date in Europe/London, `days` from today (the e2e servers use the real clock). */
function londonDate(days: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

test("a Scan of a paused Chore shows 'paused until', and Complete anyway records an Early Completion", async ({ page }) => {
  const { person, household } = await seed(page.request, {
    householdName: "The Paused Household",
    timeZone: "Europe/London",
    adminName: "Robin",
  });
  await signIn(page.request, person.id);
  const base = `/api/households/${household.id}`;
  const chore = await (
    await page.request.post(`${base}/chores`, {
      data: { name: "Water the plants", schedule: { kind: "fixed", rule: { type: "every_n_days", n: 1 } } },
    })
  ).json();
  const tag = await (await page.request.post(`${base}/tags`, { data: { choreId: chore.id } })).json();
  await page.request.post(`${base}/pauses`, { data: { choreId: chore.id, endDate: londonDate(2) } });
  const occurrences = async () => (await (await page.request.get(`${base}/chores/${chore.id}`)).json()).occurrences;

  await page.goto(tag.path);

  await expect(page.getByRole("heading", { name: /^Water the plants is paused until / })).toBeVisible();
  expect((await occurrences()).map((o: any) => o.completion)).toEqual([null]);

  await page.getByRole("button", { name: "Complete anyway" }).click();

  await expect(page.getByText(/Credited to Robin · On time · Next due/)).toBeVisible();
  await expect(page.getByText(/Completed early/)).toBeVisible();
  expect((await occurrences()).at(-1)).toMatchObject({
    dueDate: londonDate(3),
    status: "completed",
    completion: { early: true, method: "nfc", tagId: tag.id },
  });
});

test("an Admin pauses the Household, sees it on each Chore, and ends it early; past Pauses stay listed", async ({ page }) => {
  const { person } = await seed(page.request, {
    householdName: "The Holiday Household",
    timeZone: "Europe/London",
    adminName: "Robin",
  });
  await signIn(page.request, person.id);
  await page.goto("/");
  await page.getByLabel("Chore name").fill("Dishes");
  await page.getByRole("button", { name: "Add chore" }).click();
  const dishes = page.getByRole("listitem").filter({ hasText: "Dishes" });
  await expect(dishes).toContainText("Open");

  const pauses = page.getByRole("region", { name: "Pauses" });
  await pauses.getByLabel("Pause").selectOption({ label: "Whole household" });
  await pauses.getByLabel("Until (optional)").fill(londonDate(5));
  await pauses.getByRole("button", { name: "Add pause" }).click();

  await expect(dishes).toContainText("Paused until");
  await expect(dishes).toContainText("Skipped · Paused");
  const row = pauses.getByRole("row").filter({ hasText: "Whole household" });
  await expect(row).toContainText("Current");

  await row.getByRole("button", { name: "End now" }).click();

  await expect(row).toContainText("Ended early by Robin");
  await expect(row).toContainText("Past");
  await expect(dishes).not.toContainText("Paused until");
  await expect(dishes).toContainText("Open");
});

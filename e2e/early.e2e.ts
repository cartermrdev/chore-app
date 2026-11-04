import { expect, test } from "@playwright/test";
import { seed, signIn } from "./fixtures";

test("a scan with nothing due records nothing, and Complete early records an Early Completion", async ({ page }) => {
  const { person, household } = await seed(page.request, {
    householdName: "The Early Household",
    timeZone: "Europe/London",
    adminName: "Robin",
  });
  await signIn(page.request, person.id);
  const base = `/api/households/${household.id}`;
  const chore = await (
    await page.request.post(`${base}/chores`, {
      data: { name: "Change the filter", schedule: { kind: "interval", periodDays: 30 } },
    })
  ).json();
  const tag = await (await page.request.post(`${base}/tags`, { data: { choreId: chore.id } })).json();
  const occurrences = async () => (await (await page.request.get(`${base}/chores/${chore.id}`)).json()).occurrences;

  await page.goto(tag.path);
  await expect(page.getByText("Credited to Robin")).toBeVisible();

  await page.goto(tag.path); // scanned again: nothing is due
  await expect(page.getByText(/Already completed by Robin/)).toBeVisible();
  expect(await occurrences()).toHaveLength(1);

  await page.getByRole("button", { name: "Complete early" }).click();

  await expect(page.getByText("✓")).toBeVisible();
  await expect(page.getByText(/Completed early/)).toBeVisible();
  expect((await occurrences()).at(-1)).toMatchObject({
    status: "completed",
    completion: { early: true, method: "nfc", tagId: tag.id },
  });
});

test("an Admin adds Interval and One-off Chores, and anyone can complete one early in the app", async ({ page }) => {
  const { person } = await seed(page.request, {
    householdName: "The Interval Household",
    timeZone: "Europe/London",
    adminName: "Robin",
  });
  await signIn(page.request, person.id);
  await page.goto("/");

  await page.getByLabel("Chore name").fill("Change the filter");
  await page.getByLabel("Repeats").selectOption({ label: "Interval" });
  await page.getByLabel("Days after the last completion").fill("30");
  await page.getByRole("button", { name: "Add chore" }).click();
  const filter = page.getByRole("listitem").filter({ hasText: "Change the filter" });
  await expect(filter).toBeVisible();

  await page.getByLabel("Chore name").fill("Fix the gate");
  await page.getByLabel("Repeats").selectOption({ label: "One-off" });
  await page.getByLabel("Due date").fill("2030-01-15");
  await page.getByRole("button", { name: "Add chore" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Fix the gate" })).toContainText("Next due 2030-01-15");

  await filter.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(filter).toContainText("Completed by Robin");
  await filter.getByRole("button", { name: "Complete early" }).click();
  await expect(filter).toContainText("Completed early by Robin");
});

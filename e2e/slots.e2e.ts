import { expect, test } from "@playwright/test";
import { seed, signIn } from "./fixtures";

test("an Admin assigns a Chore, gives it Time Slots, and a scan shows the Assignee and On time", async ({ page }) => {
  const { person, household } = await seed(page.request, {
    householdName: "The Slots Household",
    timeZone: "Europe/London",
    adminName: "Robin",
  });
  await signIn(page.request, person.id);
  await page.goto("/");

  // A day-level Chore assigned to Robin: completing it today is On time.
  const add = page.getByRole("form", { name: "Add chore" });
  await add.getByLabel("Chore name").fill("Dishes");
  await add.getByLabel("Assignee", { exact: true }).selectOption({ label: "Robin" });
  await add.getByRole("button", { name: "Add chore" }).click();

  const row = page.getByRole("listitem").filter({ hasText: "Dishes" });
  await expect(row.getByText("Assigned to Robin")).toBeVisible();

  const { chores } = await (await page.request.get(`/api/households/${household.id}/chores`)).json();
  const tag = await (
    await page.request.post(`/api/households/${household.id}/tags`, { data: { choreId: chores[0].id } })
  ).json();
  await page.goto(tag.path);
  await expect(page.getByText(/Credited to Robin · On time · Next due/)).toBeVisible();
  await expect(page.getByText("Assigned to Robin")).toBeVisible();

  // Edit: two Time Slots, the first assigned to Robin, the second unassigned.
  await page.goto("/");
  await row.getByRole("button", { name: "Edit" }).click();
  const edit = row.getByRole("form", { name: "Edit chore" });
  await edit.getByRole("button", { name: "Add time slot" }).click();
  await edit.getByLabel("Slot 1 name").fill("Morning");
  await edit.getByLabel("Slot 1 start").fill("06:00");
  await edit.getByLabel("Slot 1 assignee").selectOption({ label: "Robin" });
  await edit.getByRole("button", { name: "Add time slot" }).click();
  await edit.getByLabel("Slot 2 name").fill("Evening");
  await edit.getByLabel("Slot 2 start").fill("17:00");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText("Every day at Morning 06:00 (Robin), Evening 17:00")).toBeVisible();

  // Remove the Evening slot again.
  await row.getByRole("button", { name: "Edit" }).click();
  await edit.getByRole("button", { name: "Remove slot 2" }).click();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText("Every day at Morning 06:00 (Robin)")).toBeVisible();
});

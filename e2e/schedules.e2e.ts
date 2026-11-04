import { expect, test } from "@playwright/test";
import { seed, signIn } from "./fixtures";

test("an Admin creates a weekday Chore, edits its Schedule to monthly, and changes the time zone", async ({ page }) => {
  const { person } = await seed(page.request, {
    householdName: "The Schedules Household",
    timeZone: "Europe/London",
    adminName: "Robin",
  });
  await signIn(page.request, person.id);
  await page.goto("/");

  const add = page.getByRole("form", { name: "Add chore" });
  await add.getByLabel("Chore name").fill("Bins");
  await add.getByLabel("Repeats").selectOption("weekdays");
  await add.getByLabel("Thu").check();
  await add.getByLabel("Every N weeks").fill("2");
  await add.getByRole("button", { name: "Add chore" }).click();

  const row = page.getByRole("listitem").filter({ hasText: "Bins" });
  await expect(row.getByText("Every 2 weeks on Thu")).toBeVisible();

  await row.getByRole("button", { name: "Edit" }).click();
  const edit = row.getByRole("form", { name: "Edit chore" });
  await edit.getByLabel("Repeats").selectOption("monthly");
  await edit.getByLabel("Day of month").fill("31");
  await edit.getByRole("button", { name: "Save" }).click();

  await expect(row.getByText("Monthly on day 31")).toBeVisible();

  const settings = page.getByRole("form", { name: "Household settings" });
  await expect(settings.getByLabel("Time zone")).toHaveValue("Europe/London");
  await settings.getByLabel("Time zone").fill("America/New_York");
  await settings.getByRole("button", { name: "Save time zone" }).click();
  await expect(page.getByText("Time zone: America/New_York")).toBeVisible();
});

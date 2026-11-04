import { expect, test } from "@playwright/test";
import { seed, signIn } from "./fixtures";

test("an Admin creates a daily Chore and completes it from the chore list", async ({ page }) => {
  const { person } = await seed(page.request, {
    householdName: "The Chore List Household",
    timeZone: "Europe/London",
    adminName: "Robin",
  });
  await signIn(page.request, person.id);
  await page.goto("/");

  await page.getByLabel("Chore name").fill("Feed the cat");
  await page.getByLabel("Every N days").fill("1");
  await page.getByRole("button", { name: "Add chore" }).click();

  const row = page.getByRole("listitem").filter({ hasText: "Feed the cat" });
  await expect(row.getByText("Open")).toBeVisible();

  await row.getByRole("button", { name: "Complete", exact: true }).click();

  await expect(row.getByText("Completed by Robin")).toBeVisible();
  await expect(row.getByRole("button", { name: "Complete", exact: true })).toHaveCount(0);
});

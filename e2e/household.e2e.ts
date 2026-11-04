import { expect, test } from "@playwright/test";
import { seed, signIn } from "./fixtures";

test("a signed-in Admin sees their Household's name", async ({ page }) => {
  const { person } = await seed(page.request, {
    householdName: "The E2E Household",
    timeZone: "Europe/London",
    adminName: "Robin",
  });

  await signIn(page.request, person.id);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "The E2E Household" })).toBeVisible();
});

test("a visitor with no session is not shown any Household", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("You are not signed in.")).toBeVisible();
});

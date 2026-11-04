import { expect, test } from "@playwright/test";
import { seed, signIn } from "./fixtures";

test("the Household history and a per-Person history show who did what", async ({ page }) => {
  const { person, household } = await seed(page.request, {
    householdName: "The History Household",
    timeZone: "Europe/London",
    adminName: "Robin",
  });
  await signIn(page.request, person.id);
  const base = `/api/households/${household.id}`;
  const sam = await (
    await page.request.post("/api/test/add-person", { data: { householdId: household.id, displayName: "Sam" } })
  ).json();
  const daily = { kind: "fixed", rule: { type: "every_n_days", n: 1 } };
  const dishes = await (
    await page.request.post(`${base}/chores`, { data: { name: "Dishes", schedule: daily, assigneeId: sam.id } })
  ).json();
  const sweep = await (await page.request.post(`${base}/chores`, { data: { name: "Sweep", schedule: daily } })).json();
  await page.request.post(`${base}/chores/${dishes.id}/complete`, { data: { idempotencyKey: "a", completerId: sam.id } });
  await page.request.post(`${base}/chores/${sweep.id}/complete`, { data: { idempotencyKey: "b", completerId: sam.id } });

  await page.goto("/");

  const history = page.getByRole("region", { name: "Household history" });
  const dishesRow = history.getByRole("row").filter({ hasText: "Dishes" });
  await expect(dishesRow).toContainText("Sam");
  await expect(dishesRow).toContainText("recorded by Robin");
  await expect(dishesRow).toContainText("Manual");
  await expect(dishesRow).toContainText("On time");

  const personHistory = page.getByRole("region", { name: "Person history" });
  await personHistory.getByLabel("Person").selectOption({ label: "Sam" });
  await expect(personHistory.getByRole("row").filter({ hasText: "Dishes" })).toContainText("Completed on time");
  await expect(
    personHistory.getByRole("region", { name: "Other completions" }).getByRole("row").filter({ hasText: "Sweep" }),
  ).toBeVisible();
});

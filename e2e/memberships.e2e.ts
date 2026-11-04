import { expect, test } from "@playwright/test";
import { seed, signIn } from "./fixtures";

test("a signed-in Person joins a second Household from an Invite and switches between them", async ({ page }) => {
  const home = await seed(page.request, { householdName: "Mum's", timeZone: "Europe/London", adminName: "Robin" });
  const other = await seed(page.request, { householdName: "Dad's", timeZone: "Europe/London", adminName: "Bea" });

  // Bea (Admin of Dad's) creates an Invite; then Robin, already signed in, opens it.
  await signIn(page.request, other.person.id);
  const res = await page.request.post(`/api/households/${other.household.id}/invites`, { data: { displayName: "Robin" } });
  expect(res.status()).toBe(201);
  const invite = await res.json();
  await signIn(page.request, home.person.id);

  await page.goto(invite.path);
  await page.getByRole("button", { name: "Join as Robin" }).click();

  // Back home with two Households: one shown at a time, switchable.
  const switcher = page.getByRole("navigation", { name: "Households" });
  await expect(switcher).toBeVisible();
  await switcher.getByRole("button", { name: "Dad's" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dad's" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Mum's" })).toHaveCount(0);

  await switcher.getByRole("button", { name: "Mum's" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Mum's" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Dad's" })).toHaveCount(0);
});

test("an Admin promotes a Person and ends a Membership; the last Admin can't be demoted", async ({ page }) => {
  const { household, person } = await seed(page.request, { householdName: "People", timeZone: "Europe/London", adminName: "Robin" });
  await signIn(page.request, person.id);
  for (const displayName of ["Sam", "Kim"]) {
    const res = await page.request.post("/api/test/add-person", { data: { householdId: household.id, displayName } });
    expect(res.status()).toBe(200);
  }
  await page.goto("/");

  const people = page.getByRole("region", { name: "People" });
  await expect(people.getByRole("row")).toHaveCount(4); // header + 3

  await people.getByRole("combobox", { name: "Role for Robin" }).selectOption("standard");
  await expect(people.getByRole("alert")).toHaveText(/at least one Admin/);
  await expect(people.getByRole("combobox", { name: "Role for Robin" })).toHaveValue("admin");

  await people.getByRole("combobox", { name: "Role for Sam" }).selectOption("admin");
  await expect(people.getByRole("combobox", { name: "Role for Sam" })).toHaveValue("admin");

  await people.getByRole("button", { name: "End Kim's membership" }).click();
  await expect(people.getByRole("row", { name: /Kim/ })).toHaveCount(0);

  await page.reload();
  await expect(people.getByRole("combobox", { name: "Role for Sam" })).toHaveValue("admin");
  await expect(people.getByRole("row", { name: /Kim/ })).toHaveCount(0);
});

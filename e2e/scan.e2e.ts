import { expect, test, type APIRequestContext } from "@playwright/test";
import { seed, signIn } from "./fixtures";

/** A signed-in Admin with a daily Chore and a Tag linked to it, set up through the API. */
async function choreWithTag(request: APIRequestContext, householdName: string) {
  const { person, household } = await seed(request, { householdName, timeZone: "Europe/London", adminName: "Robin" });
  await signIn(request, person.id);
  const base = `/api/households/${household.id}`;
  const chore = await (
    await request.post(`${base}/chores`, {
      data: { name: "Empty the dishwasher", schedule: { kind: "fixed", rule: { type: "every_n_days", n: 1 } } },
    })
  ).json();
  const tag = await (await request.post(`${base}/tags`, { data: { choreId: chore.id } })).json();
  const occurrence = async () => (await (await request.get(`${base}/chores/${chore.id}`)).json()).occurrences.at(-1);
  return { tag, occurrence };
}

test("a signed-in scan reaches the confirmation screen with zero clicks", async ({ page }) => {
  const { tag, occurrence } = await choreWithTag(page.request, "The Scan Household");

  await page.goto(tag.path);

  await expect(page.getByText("✓")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Empty the dishwasher" })).toBeVisible();
  await expect(page.getByText("Credited to Robin")).toBeVisible();
  await expect(page.getByText(/Next due/)).toBeVisible();
  expect(await occurrence()).toMatchObject({ status: "completed", completion: { method: "nfc", tagId: tag.id } });
});

test("a GET to the Tag URL alone never creates a Completion", async ({ page }) => {
  const { tag, occurrence } = await choreWithTag(page.request, "The GET Household");

  const res = await page.request.get(tag.path); // fetches the page without running it
  expect(res.status()).toBe(200);

  expect(await occurrence()).toMatchObject({ status: "open", completion: null });
});

test("an Admin creates a Tag for a Chore and sees its full URL", async ({ page }) => {
  const { person } = await seed(page.request, {
    householdName: "The Tag Household",
    timeZone: "Europe/London",
    adminName: "Robin",
  });
  await signIn(page.request, person.id);
  await page.goto("/");
  await page.getByLabel("Chore name").fill("Take out the bins");
  await page.getByRole("button", { name: "Add chore" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Take out the bins" })).toBeVisible();

  await page.getByRole("button", { name: "Create tag" }).click();
  const tagRow = page.getByRole("listitem").filter({ hasText: "/nfc/" });
  const linked = page.waitForResponse((r) => r.request().method() === "PATCH" && r.ok());
  await tagRow.getByLabel("Chore").selectOption({ label: "Take out the bins" });
  await linked;

  const url = await tagRow.getByTestId("tag-url").textContent();
  expect(url).toMatch(new RegExp(`^${page.url().replace(/\/$/, "")}/nfc/[A-Za-z0-9_-]{22,}$`));
  await page.goto(url!);
  await expect(page.getByText("Credited to Robin")).toBeVisible();
});

test("on a failing network the scan retries 3 times with one idempotency key, then offers Retry", async ({ page }) => {
  test.slow();
  const { tag, occurrence } = await choreWithTag(page.request, "The Flaky Household");
  const keys: string[] = [];
  let failing = true;
  await page.route("**/api/scan/**", async (route) => {
    keys.push(route.request().postDataJSON().idempotencyKey);
    if (failing) await route.abort("internetdisconnected");
    else await route.continue();
  });

  await page.goto(tag.path);

  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 20_000 });
  expect(keys).toHaveLength(4); // the first attempt plus 3 automatic retries
  await expect(page.getByText("✓")).toHaveCount(0);
  expect(await occurrence()).toMatchObject({ status: "open" });

  failing = false;
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByText("Credited to Robin")).toBeVisible();
  expect(new Set(keys).size).toBe(1);
});

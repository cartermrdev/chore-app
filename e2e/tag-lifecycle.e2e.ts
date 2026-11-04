import { expect, test, type APIRequestContext } from "@playwright/test";
import { seed, signIn } from "./fixtures";

/** A signed-in Admin with a daily Chore, set up through the API. */
async function adminWithChore(request: APIRequestContext, householdName: string) {
  const { person, household } = await seed(request, { householdName, timeZone: "Europe/London", adminName: "Robin" });
  await signIn(request, person.id);
  const base = `/api/households/${household.id}`;
  const chore = await (
    await request.post(`${base}/chores`, {
      data: { name: "Water the plants", schedule: { kind: "fixed", rule: { type: "every_n_days", n: 1 } } },
    })
  ).json();
  const occurrence = async () => (await (await request.get(`${base}/chores/${chore.id}`)).json()).occurrences.at(-1);
  return { base, chore, occurrence };
}

/** A well-formed Tag ID nobody has registered: a pre-written physical Tag. */
const unregisteredTagId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");

test("an Admin scanning an Unregistered Tag registers it to a Chore, and the next scan completes it", async ({ page }) => {
  const { occurrence } = await adminWithChore(page.request, "The Claim Household");
  const tagId = unregisteredTagId();

  await page.goto(`/nfc/${tagId}`);
  await expect(page.getByRole("heading", { name: "Register this tag" })).toBeVisible();
  await page.getByLabel("Chore").selectOption({ label: "Water the plants" });
  await page.getByRole("button", { name: "Register tag" }).click();

  await expect(page.getByText("This tag now completes Water the plants.")).toBeVisible();
  expect(await occurrence()).toMatchObject({ status: "open", completion: null });
  await page.goto(`/nfc/${tagId}`);
  await expect(page.getByText("Credited to Robin")).toBeVisible();
  expect(await occurrence()).toMatchObject({ status: "completed", completion: { tagId } });
});

test("an Admin scanning an unlinked Tag uses Link to a chore to fix it on the spot", async ({ page }) => {
  const { base } = await adminWithChore(page.request, "The Link Household");
  const tag = await (await page.request.post(`${base}/tags`, { data: {} })).json();

  await page.goto(tag.path);
  await expect(page.getByRole("heading", { name: "This tag isn't linked to a chore" })).toBeVisible();
  await page.getByRole("button", { name: "Link to a chore" }).click();
  await page.getByLabel("Chore").selectOption({ label: "Water the plants" });
  await page.getByRole("button", { name: "Link", exact: true }).click();

  await expect(page.getByText("This tag now completes Water the plants.")).toBeVisible();
});

test("an Admin archives a Chore with history, which unlinks its Tag", async ({ page }) => {
  const { base, chore } = await adminWithChore(page.request, "The Archive Household");
  const tag = await (await page.request.post(`${base}/tags`, { data: { choreId: chore.id } })).json();
  await page.request.post(`${base}/chores/${chore.id}/complete`, { data: { idempotencyKey: "k" } });
  await page.goto("/");
  const row = page.getByRole("listitem").filter({ hasText: "Water the plants" }).filter({ hasText: "Archive" });

  await row.getByRole("button", { name: "Delete" }).click();
  await expect(row.getByText("This chore has history, so it can only be archived.")).toBeVisible();
  await row.getByRole("button", { name: "Archive" }).click();

  await expect(row).toHaveCount(0);
  await page.goto(tag.path);
  await expect(page.getByRole("heading", { name: "This tag isn't linked to a chore" })).toBeVisible();
});

import { expect, test, type APIRequestContext } from "@playwright/test";
import { seed, signIn } from "./fixtures";

/** A signed-in Admin "Robin" with a daily Chore and a Tag linked to it. */
async function choreWithTag(request: APIRequestContext, householdName: string) {
  const { person, household } = await seed(request, { householdName, timeZone: "Europe/London", adminName: "Robin" });
  await signIn(request, person.id);
  const base = `/api/households/${household.id}`;
  const chore = await (
    await request.post(`${base}/chores`, {
      data: { name: "Feed the cat", schedule: { kind: "fixed", rule: { type: "every_n_days", n: 1 } } },
    })
  ).json();
  const tag = await (await request.post(`${base}/tags`, { data: { choreId: chore.id } })).json();
  const detail = async () => (await (await request.get(`${base}/chores/${chore.id}`)).json()).occurrences.at(-1);
  return { tag, detail, base, chore, household };
}

test("the Completer can Undo from the confirmation screen", async ({ page }) => {
  const { tag, detail } = await choreWithTag(page.request, "The Undo Household");
  await page.goto(tag.path);
  await expect(page.getByText("Credited to Robin")).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();

  await expect(page.getByText("Undone. Nothing is recorded for this scan.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
  expect(await detail()).toMatchObject({ status: "open", completion: null, voidedCompletions: [{ method: "nfc" }] });
});

test("the Undo button disappears after 5 minutes", async ({ page }) => {
  await page.clock.install();
  const { tag } = await choreWithTag(page.request, "The Undo Expiry Household");
  await page.goto(tag.path);
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();

  await page.clock.fastForward("05:01");

  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect(page.getByText("Credited to Robin")).toBeVisible();
});

test("an Admin records for someone else, Voids it, and Excuses the Occurrence", async ({ page }) => {
  const { base, chore, household } = await choreWithTag(page.request, "The Admin Corrections Household");
  // Add a Standard Person "Sam" via the test-only seed endpoint.
  const res = await page.request.post("/api/test/add-person", {
    data: { householdId: household.id, displayName: "Sam", role: "standard" },
  });
  expect(res.status(), await res.text()).toBe(200);
  await page.goto("/");
  const row = page.getByRole("listitem").filter({ hasText: "Feed the cat" });

  await row.getByLabel("Complete for").selectOption({ label: "Sam" });
  await row.getByRole("button", { name: "Complete" }).click();
  await expect(row.getByText("Completed by Sam (recorded by Robin)")).toBeVisible();

  await row.getByRole("button", { name: "Void" }).click();
  await expect(row.getByText("Open")).toBeVisible();

  await row.getByLabel("Excuse note").fill("Sam is ill");
  await row.getByRole("button", { name: "Excuse" }).click();
  await expect(row.getByText("Skipped · Excused: Sam is ill")).toBeVisible();

  const occ = (await (await page.request.get(`${base}/chores/${chore.id}`)).json()).occurrences.at(-1);
  expect(occ).toMatchObject({
    status: "skipped",
    excuse: { note: "Sam is ill", excusedBy: { displayName: "Robin" } },
    voidedCompletions: [{ completer: { displayName: "Sam" }, recorder: { displayName: "Robin" }, voidedBy: { displayName: "Robin" } }],
  });
});

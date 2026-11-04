import { expect, test, type Page } from "@playwright/test";
import { lastMailTo, seed, signIn } from "./fixtures";

/**
 * Real passkeys in the browser: Chromium's virtual authenticator stands in for
 * Face ID, and the backend runs the real WebAuthn verification.
 */
async function addVirtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

test("an invited Person enrols a passkey; a logged-out scan signs in and then completes without scanning again", async ({
  page,
}) => {
  const { person, household } = await seed(page.request, {
    householdName: "The Passkey Household",
    timeZone: "Europe/London",
    adminName: "Robin",
  });
  await signIn(page.request, person.id);
  const base = `/api/households/${household.id}`;
  const chore = await (
    await page.request.post(`${base}/chores`, {
      data: { name: "Feed the cat", schedule: { kind: "fixed", rule: { type: "every_n_days", n: 1 } } },
    })
  ).json();
  const tag = await (await page.request.post(`${base}/tags`, { data: { choreId: chore.id } })).json();
  const invite = await (await page.request.post(`${base}/invites`, { data: { displayName: "Sam" } })).json();
  await page.context().clearCookies(); // hand the phone to Sam

  await addVirtualAuthenticator(page);
  await page.goto(invite.path);
  await expect(page.getByRole("heading", { name: "Join The Passkey Household" })).toBeVisible();
  await page.getByRole("button", { name: "Set up a passkey" }).click();
  await expect(page.getByText("Signed in as Sam")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("You are not signed in.")).toBeVisible();

  await page.goto(tag.path);
  await expect(page).toHaveURL(/\/sign-in\?/);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();

  await expect(page).toHaveURL(new RegExp(`${tag.path}$`));
  await expect(page.getByText("✓")).toBeVisible();
  await expect(page.getByText("Credited to Sam")).toBeVisible();
});

test("an Admin creates an Invite and is shown its link and QR code", async ({ page }) => {
  const { person } = await seed(page.request, {
    householdName: "The Invite Household",
    timeZone: "Europe/London",
    adminName: "Robin",
  });
  await signIn(page.request, person.id);
  await page.goto("/");

  await page.getByLabel("Name of the person to invite").fill("Kit");
  await page.getByRole("button", { name: "Create invite" }).click();

  const link = await page.getByTestId("invite-url").textContent();
  expect(link).toMatch(new RegExp(`^${page.url().replace(/\/$/, "")}/invite/[A-Za-z0-9_-]{40,}$`));
  await expect(page.getByRole("img", { name: "Invite QR code" })).toBeVisible();
});

test("a Person with an email address signs in with a magic link and continues where they were going", async ({ page }) => {
  const { person } = await seed(page.request, {
    householdName: "The Email Household",
    timeZone: "Europe/London",
    adminName: "Robin",
  });
  await signIn(page.request, person.id);
  const email = `robin-${Date.now()}@example.com`;
  expect((await page.request.patch("/api/me", { data: { email } })).ok()).toBe(true);
  await page.context().clearCookies();

  await page.goto("/sign-in?next=%2F");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("check your email", { exact: false })).toBeVisible();

  const mail = await lastMailTo(page.request, email);
  await page.goto(mail.text.match(/https?:\/\/\S+/)![0]);

  await expect(page.getByText("Signed in as Robin")).toBeVisible();
});

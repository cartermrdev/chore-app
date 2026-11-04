import { expect, type APIRequestContext } from "@playwright/test";

// Helpers that use the backend's test-only endpoints (/api/test/*), which
// exist only when ENABLE_TEST_AUTH=1 (never in production). Using
// page.request shares the cookie jar with the page, so signIn() signs the
// browser in.

export type SeedResult = {
  household: { id: string; name: string; timeZone: string };
  person: { id: string; displayName: string };
};

export async function seed(
  request: APIRequestContext,
  input: { householdName: string; timeZone: string; adminName: string },
): Promise<SeedResult> {
  const res = await request.post("/api/test/seed", { data: input });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** The latest email the backend "sent" to `to` (test mode keeps mail in an outbox). */
export async function lastMailTo(request: APIRequestContext, to: string): Promise<{ to: string; subject: string; text: string }> {
  const res = await request.get(`/api/test/outbox?to=${encodeURIComponent(to)}`);
  expect(res.status(), await res.text()).toBe(200);
  const { mails } = await res.json();
  expect(mails.length).toBeGreaterThan(0);
  return mails.at(-1);
}

export async function signIn(request: APIRequestContext, personId: string): Promise<void> {
  const res = await request.post("/api/test/sign-in", { data: { personId } });
  expect(res.status(), await res.text()).toBe(200);
}

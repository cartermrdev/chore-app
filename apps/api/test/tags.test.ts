import { describe, expect, test } from "bun:test";
import { useTestApp } from "./harness";

const daily = { kind: "fixed", rule: { type: "every_n_days", n: 1 } };

describe("Tags", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  async function household() {
    const { person, household } = await t.seed({ adminName: "Alex" });
    const admin = await t.signIn(person.id);
    const sam = await t.addPerson(household.id, { displayName: "Sam", role: "standard" });
    const standard = await t.signIn(sam.id);
    const base = `/api/households/${household.id}`;
    const chore = await (await admin.post(`${base}/chores`, { name: "Dishes", schedule: daily })).json();
    return { admin, standard, base, chore, household };
  }

  test("an Admin creates a Tag with a random, URL-safe ID of at least 128 bits and a permanent /nfc URL", async () => {
    const h = await household();

    const res = await h.admin.post(`${h.base}/tags`, { choreId: h.chore.id });

    expect(res.status).toBe(201);
    const tag = await res.json();
    expect(tag.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tag.id.length * 6).toBeGreaterThanOrEqual(128); // base64url: 6 bits per character
    expect(tag).toMatchObject({ path: `/nfc/${tag.id}`, chore: { id: h.chore.id, name: "Dishes" } });

    const other = await (await h.admin.post(`${h.base}/tags`, {})).json();
    expect(other.id).not.toBe(tag.id);
    expect(other.chore).toBeNull();
  });

  test("the Household's Tags are listed with their Chore", async () => {
    const h = await household();
    const linked = await (await h.admin.post(`${h.base}/tags`, { choreId: h.chore.id })).json();
    const loose = await (await h.admin.post(`${h.base}/tags`, {})).json();

    const { tags } = await (await h.admin.get(`${h.base}/tags`)).json();

    expect(tags).toEqual(
      expect.arrayContaining([
        { id: linked.id, path: `/nfc/${linked.id}`, chore: { id: h.chore.id, name: "Dishes" } },
        { id: loose.id, path: `/nfc/${loose.id}`, chore: null },
      ]),
    );
    expect(tags).toHaveLength(2);
  });

  test("an Admin can point a Tag at a different Chore, or at none", async () => {
    const h = await household();
    const bins = await (await h.admin.post(`${h.base}/chores`, { name: "Bins", schedule: daily })).json();
    const tag = await (await h.admin.post(`${h.base}/tags`, { choreId: h.chore.id })).json();

    const relinked = await h.admin.patch(`${h.base}/tags/${tag.id}`, { choreId: bins.id });
    expect(relinked.status).toBe(200);
    expect((await relinked.json()).chore).toEqual({ id: bins.id, name: "Bins" });

    const unlinked = await (await h.admin.patch(`${h.base}/tags/${tag.id}`, { choreId: null })).json();
    expect(unlinked.chore).toBeNull();

    const { tags } = await (await h.admin.get(`${h.base}/tags`)).json();
    expect(tags[0].chore).toBeNull();
  });

  test("a Tag cannot be linked to another Household's Chore", async () => {
    const h = await household();
    const other = await household();

    expect((await h.admin.post(`${h.base}/tags`, { choreId: other.chore.id })).status).toBe(400);
    const tag = await (await h.admin.post(`${h.base}/tags`, {})).json();
    expect((await h.admin.patch(`${h.base}/tags/${tag.id}`, { choreId: other.chore.id })).status).toBe(400);
    expect((await other.admin.patch(`${other.base}/tags/${tag.id}`, { choreId: other.chore.id })).status).toBe(404);
  });

  test("only Admins manage Tags", async () => {
    const h = await household();
    const tag = await (await h.admin.post(`${h.base}/tags`, {})).json();

    expect((await h.standard.post(`${h.base}/tags`, {})).status).toBe(403);
    expect((await h.standard.patch(`${h.base}/tags/${tag.id}`, { choreId: h.chore.id })).status).toBe(403);
    expect((await h.standard.get(`${h.base}/tags`)).status).toBe(403);
  });
});

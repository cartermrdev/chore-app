import { describe, expect, test } from "bun:test";
import { useTestApp, type TestClient } from "./harness";

const daily = { kind: "fixed", rule: { type: "every_n_days", n: 1 } };
/** Well-formed (24 base64url chars, like a generated Tag ID) but never seen by the system. */
const freshTagId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");

describe("Tag lifecycle", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  async function household() {
    t.clock.set("2026-03-01T09:00:00Z");
    const { person, household } = await t.seed({ householdName: "The Smiths", timeZone: "Europe/London", adminName: "Alex" });
    const admin = await t.signIn(person.id);
    const sam = await t.addPerson(household.id, { displayName: "Sam", role: "standard" });
    const standard = await t.signIn(sam.id);
    const base = `/api/households/${household.id}`;
    const chore = await (await admin.post(`${base}/chores`, { name: "Dishes", schedule: daily })).json();
    const scan = (client: TestClient, tagId: string, idempotencyKey = crypto.randomUUID()) =>
      client.post(`/api/scan/${tagId}`, { idempotencyKey });
    const detail = async (choreId = chore.id) => (await admin.get(`${base}/chores/${choreId}`)).json();
    const tags = async () => (await (await admin.get(`${base}/tags`)).json()).tags;
    return { admin, standard, sam, household, base, chore, scan, detail, tags };
  }

  describe("Unregistered Tags", () => {
    test("an Admin scanning a never-seen Tag is offered to claim it for their Household", async () => {
      const h = await household();

      const res = await h.scan(h.admin, freshTagId());

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        outcome: "tag_unregistered",
        canClaim: true,
        households: [{ id: h.household.id, name: "The Smiths" }],
      });
    });

    test("an Admin claims a scanned Unregistered Tag for their Household and links it to a Chore in one request", async () => {
      const h = await household();
      const tagId = freshTagId();
      await h.scan(h.admin, tagId);

      const res = await h.admin.post(`${h.base}/tags/${tagId}/claim`, { choreId: h.chore.id });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: tagId, path: `/nfc/${tagId}`, chore: { id: h.chore.id, name: "Dishes" } });
      expect(await h.tags()).toEqual([{ id: tagId, path: `/nfc/${tagId}`, chore: { id: h.chore.id, name: "Dishes" } }]);
      const scan = await (await h.scan(h.standard, tagId)).json();
      expect(scan).toMatchObject({ outcome: "completed", chore: { name: "Dishes" }, completion: { tagId, method: "nfc" } });
    });

    test("a Standard Person scanning an Unregistered Tag cannot claim it, and nothing is created", async () => {
      const h = await household();
      const tagId = freshTagId();

      const scan = await (await h.scan(h.standard, tagId)).json();
      const claim = await h.standard.post(`${h.base}/tags/${tagId}/claim`, { choreId: h.chore.id });

      expect(scan).toEqual({ outcome: "tag_unregistered", canClaim: false, households: [] });
      expect(claim.status).toBe(403);
      expect(await h.tags()).toEqual([]);
      expect(await (await h.scan(h.standard, tagId)).json()).toMatchObject({ outcome: "tag_unregistered" });
      expect((await h.detail()).occurrences[0]).toMatchObject({ status: "open", completion: null });
    });

    test("a malformed Tag ID is not an Unregistered Tag: scanning it is not found and it cannot be claimed", async () => {
      const h = await household();

      expect((await h.scan(h.admin, "not-a-tag")).status).toBe(404);
      expect((await h.admin.post(`${h.base}/tags/not-a-tag/claim`, { choreId: h.chore.id })).status).toBe(400);
      expect(await h.tags()).toEqual([]);
    });

    test("a Tag that is already registered cannot be claimed again, by its own or another Household", async () => {
      const h = await household();
      const other = await household();
      const tagId = freshTagId();
      await h.admin.post(`${h.base}/tags/${tagId}/claim`, { choreId: h.chore.id });

      const again = await h.admin.post(`${h.base}/tags/${tagId}/claim`, { choreId: null });
      const stolen = await other.admin.post(`${other.base}/tags/${tagId}/claim`, { choreId: other.chore.id });

      expect(again.status).toBe(409);
      expect(stolen.status).toBe(409);
      expect((await h.tags())[0].chore).toEqual({ id: h.chore.id, name: "Dishes" });
      expect(await other.tags()).toEqual([]);
    });

    test("a claim must name a Chore of the claiming Household, or none", async () => {
      const h = await household();
      const other = await household();
      const foreign = freshTagId();
      const loose = freshTagId();

      expect((await h.admin.post(`${h.base}/tags/${foreign}/claim`, { choreId: other.chore.id })).status).toBe(400);
      const res = await h.admin.post(`${h.base}/tags/${loose}/claim`, { choreId: null });

      expect(res.status).toBe(201);
      expect(await h.tags()).toEqual([{ id: loose, path: `/nfc/${loose}`, chore: null }]);
      expect(await (await h.scan(h.admin, foreign)).json()).toMatchObject({ outcome: "tag_unregistered" });
    });
  });

  describe("Re-pointing and several Tags per Chore", () => {
    test("a Tag pointed at a different Chore completes the new Chore on later Scans", async () => {
      const h = await household();
      const bins = await (await h.admin.post(`${h.base}/chores`, { name: "Bins", schedule: daily })).json();
      const tag = await (await h.admin.post(`${h.base}/tags`, { choreId: h.chore.id })).json();
      await h.scan(h.standard, tag.id);
      t.clock.set("2026-03-02T09:00:00Z");

      await h.admin.patch(`${h.base}/tags/${tag.id}`, { choreId: bins.id });
      const scan = await (await h.scan(h.standard, tag.id)).json();

      expect(scan).toMatchObject({ outcome: "completed", chore: { id: bins.id, name: "Bins" } });
      expect((await h.detail(bins.id)).occurrences.at(-1)).toMatchObject({ status: "completed", completion: { tagId: tag.id } });
      expect((await h.detail()).occurrences.at(-1)).toMatchObject({ dueDate: "2026-03-02", status: "open" });
    });

    test("a Scan of any of a Chore's Tags completes the same Occurrence", async () => {
      const h = await household();
      const front = await (await h.admin.post(`${h.base}/tags`, { choreId: h.chore.id })).json();
      const back = await (await h.admin.post(`${h.base}/tags`, { choreId: h.chore.id })).json();

      const first = await (await h.scan(h.standard, back.id)).json();
      const second = await (await h.scan(h.admin, front.id)).json();

      expect(first).toMatchObject({ outcome: "completed", completion: { tagId: back.id } });
      expect(second).toMatchObject({ outcome: "already_completed", completion: { id: first.completion.id } });
      const { occurrences } = await h.detail();
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].completion).toMatchObject({ id: first.completion.id, tagId: back.id });
    });
  });

  describe("Archive", () => {
    test("archiving a Chore stops new Occurrences, keeps its Completions visible and unlinks its Tags", async () => {
      const h = await household();
      const tag = await (await h.admin.post(`${h.base}/tags`, { choreId: h.chore.id })).json();
      const done = await (await h.scan(h.standard, tag.id)).json();

      const res = await h.admin.post(`${h.base}/chores/${h.chore.id}/archive`);
      t.clock.set("2026-03-05T09:00:00Z");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: h.chore.id, name: "Dishes", archivedAt: "2026-03-01T09:00:00.000Z" });
      const detail = await h.detail();
      expect(detail.archivedAt).toBe("2026-03-01T09:00:00.000Z");
      expect(detail.occurrences).toHaveLength(1);
      expect(detail.occurrences[0]).toMatchObject({ status: "completed", completion: { id: done.completion.id, tagId: tag.id } });
      const { chores } = await (await h.admin.get(`${h.base}/chores`)).json();
      expect(chores.map((c: any) => c.id)).not.toContain(h.chore.id);
      expect((await h.tags())[0].chore).toBeNull();
      expect(await (await h.scan(h.standard, tag.id)).json()).toMatchObject({ outcome: "tag_unlinked", canLink: false });
      expect(await (await h.scan(h.admin, tag.id)).json()).toMatchObject({ outcome: "tag_unlinked", canLink: true });
    });

    test("an archived Chore cannot be completed or have Tags pointed at it", async () => {
      const h = await household();
      await h.admin.post(`${h.base}/chores/${h.chore.id}/archive`);

      const manual = await h.standard.post(`${h.base}/chores/${h.chore.id}/complete`, { idempotencyKey: "k" });
      const create = await h.admin.post(`${h.base}/tags`, { choreId: h.chore.id });

      expect(manual.status).toBe(404);
      expect(create.status).toBe(400);
    });

    test("archiving twice keeps the first archive time, and only Admins can archive", async () => {
      const h = await household();

      expect((await h.standard.post(`${h.base}/chores/${h.chore.id}/archive`)).status).toBe(403);
      await h.admin.post(`${h.base}/chores/${h.chore.id}/archive`);
      t.clock.set("2026-03-02T09:00:00Z");
      const again = await h.admin.post(`${h.base}/chores/${h.chore.id}/archive`);

      expect(again.status).toBe(200);
      expect((await again.json()).archivedAt).toBe("2026-03-01T09:00:00.000Z");
      expect((await h.admin.post(`${h.base}/chores/00000000-0000-0000-0000-000000000000/archive`)).status).toBe(404);
    });

    test("another Household's Admin cannot archive the Chore", async () => {
      const h = await household();
      const other = await household();

      const res = await other.admin.post(`${other.base}/chores/${h.chore.id}/archive`);

      expect(res.status).toBe(404);
      expect((await h.detail()).archivedAt).toBeNull();
    });
  });

  describe("Deleting", () => {
    test("a Chore with no history can be deleted outright, and its Tags are left unlinked", async () => {
      const h = await household();
      const tag = await (await h.admin.post(`${h.base}/tags`, { choreId: h.chore.id })).json();
      await h.detail(); // materialises an Open Occurrence: not history

      const res = await h.admin.delete(`${h.base}/chores/${h.chore.id}`);

      expect(res.status).toBe(204);
      expect((await h.admin.get(`${h.base}/chores/${h.chore.id}`)).status).toBe(404);
      expect(await h.tags()).toEqual([{ id: tag.id, path: `/nfc/${tag.id}`, chore: null }]);
    });

    test("deleting a Chore that has Completions is rejected, even when it is Archived", async () => {
      const h = await household();
      await h.standard.post(`${h.base}/chores/${h.chore.id}/complete`, { idempotencyKey: "k" });
      await h.admin.post(`${h.base}/chores/${h.chore.id}/archive`);

      const res = await h.admin.delete(`${h.base}/chores/${h.chore.id}`);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "has_history" });
      expect((await h.detail()).occurrences[0].status).toBe("completed");
    });

    test("a Tag with no Completions can be deleted; one with Completions cannot", async () => {
      const h = await household();
      const used = await (await h.admin.post(`${h.base}/tags`, { choreId: h.chore.id })).json();
      const spare = await (await h.admin.post(`${h.base}/tags`, { choreId: h.chore.id })).json();
      await h.scan(h.standard, used.id);

      const rejected = await h.admin.delete(`${h.base}/tags/${used.id}`);
      const deleted = await h.admin.delete(`${h.base}/tags/${spare.id}`);

      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toEqual({ error: "has_history" });
      expect(deleted.status).toBe(204);
      expect((await h.tags()).map((t: any) => t.id)).toEqual([used.id]);
      expect((await h.detail()).occurrences[0].completion).toMatchObject({ tagId: used.id });
    });

    test("only Admins of the Household can delete Chores and Tags", async () => {
      const h = await household();
      const other = await household();
      const tag = await (await h.admin.post(`${h.base}/tags`, {})).json();

      expect((await h.standard.delete(`${h.base}/chores/${h.chore.id}`)).status).toBe(403);
      expect((await h.standard.delete(`${h.base}/tags/${tag.id}`)).status).toBe(403);
      expect((await other.admin.delete(`${other.base}/chores/${h.chore.id}`)).status).toBe(404);
      expect((await other.admin.delete(`${other.base}/tags/${tag.id}`)).status).toBe(404);
      expect((await h.admin.get(`${h.base}/chores/${h.chore.id}`)).status).toBe(200);
      expect(await h.tags()).toHaveLength(1);
    });
  });
});

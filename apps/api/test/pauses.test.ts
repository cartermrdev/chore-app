import { describe, expect, test } from "bun:test";
import { useTestApp, type TestClient } from "./harness";

describe("Pauses", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });
  const daily = { kind: "fixed", rule: { type: "every_n_days", n: 1 } };

  /** A Household (Europe/London) with an Admin "Alex", a Standard "Sam" and one Chore with the given Schedule. */
  async function household(schedule: unknown = daily) {
    const { person, household } = await t.seed({ timeZone: "Europe/London", adminName: "Alex" });
    const admin = await t.signIn(person.id);
    const sam = await t.addPerson(household.id, { displayName: "Sam", role: "standard" });
    const standard = await t.signIn(sam.id);
    const hid = household.id;
    const chores = `/api/households/${hid}/chores`;
    const pauses = `/api/households/${hid}/pauses`;
    const chore = await (await admin.post(chores, { name: "Dishes", schedule })).json();
    const detail = async (id = chore.id) => (await admin.get(`${chores}/${id}`)).json();
    const statuses = async (id = chore.id) => (await detail(id)).occurrences.map((o: any) => [o.dueDate, o.status]);
    const pause = (body: unknown, client: TestClient = admin) => client.post(pauses, body);
    const list = async () => (await (await admin.get(pauses)).json()).pauses;
    return { admin, standard, alex: person, sam, hid, chores, pauses, chore, detail, statuses, pause, list };
  }

  test("an Admin pauses a Chore in advance; Fixed Occurrences inside the Pause are Skipped, never Missed", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();

    const res = await h.pause({ choreId: h.chore.id, startDate: "2026-03-03", endDate: "2026-03-04" });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      chore: { id: h.chore.id, name: "Dishes" },
      startDate: "2026-03-03",
      endDate: "2026-03-04",
      createdBy: { id: h.alex.id, displayName: "Alex" },
      endedEarlyAt: null,
    });
    t.clock.set("2026-03-06T09:00:00Z");
    expect(await h.statuses()).toEqual([
      ["2026-03-01", "missed"],
      ["2026-03-02", "missed"],
      ["2026-03-03", "skipped"],
      ["2026-03-04", "skipped"],
      ["2026-03-05", "missed"],
      ["2026-03-06", "open"],
    ]);
  });

  test("a Household Pause starting now Skips today's Open Occurrence of every Chore, and says which Pause did it", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    const bins = await (await h.admin.post(h.chores, { name: "Bins", schedule: daily })).json();
    expect(await h.statuses()).toEqual([["2026-03-01", "open"]]);

    const pause = await (await h.pause({ endDate: "2026-03-02" })).json();

    expect(pause).toMatchObject({ chore: null, startDate: "2026-03-01", endDate: "2026-03-02", state: "current" });
    for (const id of [h.chore.id, bins.id]) {
      const detail = await h.detail(id);
      expect(detail.occurrences).toEqual([
        expect.objectContaining({
          dueDate: "2026-03-01",
          status: "skipped",
          excuse: null,
          skippedByPause: { id: pause.id, choreId: null, startDate: "2026-03-01", endDate: "2026-03-02" },
        }),
      ]);
      expect(detail).toMatchObject({ paused: { until: "2026-03-02" }, nextDue: { dueDate: "2026-03-03" } });
    }
  });

  test("an Interval due date inside a Pause moves to the Pause's end and stays Open; it is never Skipped", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household({ kind: "interval", periodDays: 5 });
    await h.admin.post(`${h.chores}/${h.chore.id}/complete`, { idempotencyKey: "k1" }); // next due 03-06
    await h.pause({ choreId: h.chore.id, startDate: "2026-03-04", endDate: "2026-03-09" });

    expect(await h.detail()).toMatchObject({ nextDue: { dueDate: "2026-03-10" } });
    t.clock.set("2026-03-08T09:00:00Z");
    expect(await h.statuses()).toEqual([["2026-03-01", "completed"]]);
    t.clock.set("2026-03-15T09:00:00Z");
    expect(await h.statuses()).toEqual([
      ["2026-03-01", "completed"],
      ["2026-03-10", "open"],
    ]);
  });

  test("an Interval Occurrence already Open when a Pause starts stays Open through it", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household({ kind: "interval", periodDays: 5 });
    expect(await h.statuses()).toEqual([["2026-03-01", "open"]]);
    await h.pause({ choreId: h.chore.id, endDate: "2026-03-03" });
    expect(await h.statuses()).toEqual([["2026-03-01", "open"]]);
    t.clock.set("2026-03-05T09:00:00Z");
    expect(await h.statuses()).toEqual([["2026-03-01", "open"]]);
  });

  test("ending a Pause early makes Occurrences fall due normally from today", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    const pause = await (await h.pause({ choreId: h.chore.id })).json(); // indefinite, from today
    t.clock.set("2026-03-03T09:00:00Z");
    expect(await h.detail()).toMatchObject({ paused: { until: null }, nextDue: null });

    const res = await h.admin.post(`${h.pauses}/${pause.id}/end`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: pause.id,
      startDate: "2026-03-01",
      endDate: "2026-03-02",
      plannedEndDate: null,
      endedEarlyAt: "2026-03-03T09:00:00.000Z",
      endedEarlyBy: { id: h.alex.id, displayName: "Alex" },
      state: "past",
    });
    expect(await h.detail()).toMatchObject({ paused: null, nextDue: { dueDate: "2026-03-03" } });
    expect(await h.statuses()).toEqual([
      ["2026-03-01", "skipped"],
      ["2026-03-02", "skipped"],
      ["2026-03-03", "open"],
    ]);
    const done = await (await h.admin.post(`${h.chores}/${h.chore.id}/complete`, { idempotencyKey: "c1" })).json();
    expect(done).toMatchObject({ outcome: "completed", completion: { dueDate: "2026-03-03", late: false } });
    t.clock.set("2026-03-05T09:00:00Z");
    expect((await h.statuses()).slice(3)).toEqual([
      ["2026-03-04", "missed"],
      ["2026-03-05", "open"],
    ]);
  });

  test("an advance Pause ended before it starts covers nothing; one that is already over can't be ended", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    const advance = await (await h.pause({ choreId: h.chore.id, startDate: "2026-03-05", endDate: "2026-03-06" })).json();
    expect(advance.state).toBe("upcoming");
    const short = await (await h.pause({ choreId: h.chore.id, startDate: "2026-03-01", endDate: "2026-03-01" })).json();

    const ended = await h.admin.post(`${h.pauses}/${advance.id}/end`);

    expect(await ended.json()).toMatchObject({ state: "past", plannedEndDate: "2026-03-06" });
    t.clock.set("2026-03-07T09:00:00Z");
    expect((await h.statuses()).map(([, s]: string[]) => s)).toEqual(["skipped", "missed", "missed", "missed", "missed", "missed", "open"]);
    expect((await h.admin.post(`${h.pauses}/${short.id}/end`)).status).toBe(409);
    expect((await h.admin.post(`${h.pauses}/${advance.id}/end`)).status).toBe(409);
    expect((await h.admin.post(`${h.pauses}/00000000-0000-0000-0000-000000000000/end`)).status).toBe(404);
    expect((await h.admin.post(`${h.pauses}/not-a-uuid/end`)).status).toBe(404);
  });

  test("past Pauses stay viewable as history by everyone in the Household", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    await h.pause({ choreId: h.chore.id, endDate: "2026-03-02" });
    await h.pause({ startDate: "2026-03-10", endDate: "2026-03-12" });
    t.clock.set("2026-03-11T09:00:00Z");

    const res = await h.standard.get(h.pauses);

    expect(res.status).toBe(200);
    expect((await res.json()).pauses).toEqual([
      expect.objectContaining({ chore: null, startDate: "2026-03-10", endDate: "2026-03-12", state: "current" }),
      expect.objectContaining({
        chore: { id: h.chore.id, name: "Dishes" },
        startDate: "2026-03-01",
        endDate: "2026-03-02",
        state: "past",
        createdBy: { id: h.alex.id, displayName: "Alex" },
      }),
    ]);
  });

  test("invalid Pauses are rejected", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    const other = await t.seed({ timeZone: "Europe/London" });
    const foreign = await (await (await t.signIn(other.person.id)).post(`/api/households/${other.household.id}/chores`, { name: "X", schedule: daily })).json();
    await h.admin.post(`${h.chores}/${h.chore.id}/archive`);

    const attempts = {
      "start in the past": await h.pause({ startDate: "2026-02-28" }),
      "end before start": await h.pause({ startDate: "2026-03-05", endDate: "2026-03-04" }),
      "not a date": await h.pause({ startDate: "next week" }),
      "archived Chore": await h.pause({ choreId: h.chore.id }),
      "another Household's Chore": await h.pause({ choreId: foreign.id }),
      "malformed Chore id": await h.pause({ choreId: "nope" }),
    };

    const result = Object.fromEntries(
      await Promise.all(Object.entries(attempts).map(async ([k, r]) => [k, [r.status, (await r.json()).error]])),
    );
    expect(result).toEqual({
      "start in the past": [400, "start_in_past"],
      "end before start": [400, "invalid_dates"],
      "not a date": [400, "invalid_dates"],
      "archived Chore": [400, "chore_not_found"],
      "another Household's Chore": [400, "chore_not_found"],
      "malformed Chore id": [400, "chore_not_found"],
    });
    expect(await h.list()).toEqual([]);
  });

  test("outsiders see nothing", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    const pause = await (await h.pause({})).json();
    const outsider = await t.signIn((await t.seed()).person.id);
    expect((await outsider.get(h.pauses)).status).toBe(404);
    expect((await outsider.post(h.pauses, {})).status).toBe(404);
    expect((await outsider.post(`${h.pauses}/${pause.id}/end`)).status).toBe(404);
  });

  test("Standard Persons get 403 on every Pause action and nothing changes", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    const pause = await (await h.pause({ startDate: "2026-03-05" })).json();

    const statuses = [
      (await h.pause({ choreId: h.chore.id }, h.standard)).status,
      (await h.pause({}, h.standard)).status,
      (await h.standard.post(`${h.pauses}/${pause.id}/end`)).status,
    ];

    expect(statuses).toEqual([403, 403, 403]);
    expect(await h.list()).toEqual([expect.objectContaining({ id: pause.id, endedEarlyAt: null, endDate: null })]);
  });

  test("a Chore whose only history is Pauses can still be deleted; its Pauses go with it", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    await h.pause({ choreId: h.chore.id, endDate: "2026-03-02" });
    await h.pause({ endDate: "2026-03-02" });
    t.clock.set("2026-03-04T09:00:00Z");
    expect((await h.statuses()).slice(0, 2)).toEqual([
      ["2026-03-01", "skipped"],
      ["2026-03-02", "skipped"],
    ]);

    expect((await h.admin.delete(`${h.chores}/${h.chore.id}`)).status).toBe(204);

    expect(await h.list()).toEqual([expect.objectContaining({ chore: null })]);
  });

  describe("scanning a paused Chore", () => {
    async function withTag() {
      const h = await household();
      const tag = await (await h.admin.post(`/api/households/${h.hid}/tags`, { choreId: h.chore.id })).json();
      const scan = (client: TestClient, idempotencyKey: string) => client.post(`/api/scan/${tag.id}`, { idempotencyKey });
      return { ...h, tag, scan };
    }

    test("shows 'paused until' and records nothing", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await withTag();
      await h.pause({ choreId: h.chore.id, endDate: "2026-03-04" });

      const res = await h.scan(h.standard, "s1");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        outcome: "paused",
        chore: { id: h.chore.id, name: "Dishes" },
        until: "2026-03-04",
        nextDue: { dueDate: "2026-03-05", timeSlot: null, dueTime: "2026-03-06T00:00:00.000Z" },
        completeAnywayOffered: true,
      });
      expect(await h.statuses()).toEqual([["2026-03-01", "skipped"]]);
    });

    test("an indefinite Household Pause shows no end date, and offers Complete anyway on the next Occurrence ignoring the Pause", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await withTag();
      await h.pause({});

      const paused = await (await h.scan(h.standard, "s1")).json();

      expect(paused).toMatchObject({
        outcome: "paused",
        until: null,
        nextDue: { dueDate: "2026-03-02", timeSlot: null },
        completeAnywayOffered: true,
      });
      const res = await h.standard.post(`/api/scan/${h.tag.id}/complete-early`, {
        idempotencyKey: "e1",
        dueDate: paused.nextDue.dueDate,
        timeSlot: paused.nextDue.timeSlot,
      });
      expect(await res.json()).toMatchObject({
        outcome: "completed",
        completion: { dueDate: "2026-03-02", early: true, method: "nfc" },
      });
      t.clock.set("2026-03-03T09:00:00Z");
      expect(await h.statuses()).toEqual([
        ["2026-03-01", "skipped"],
        ["2026-03-02", "completed"],
        ["2026-03-03", "skipped"],
      ]);
    });

    test("an indefinite Pause still offers Complete anyway in the app, and ending the Pause keeps that Completion", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const pause = await (await h.pause({ choreId: h.chore.id })).json();

      const chore = await h.detail();
      expect(chore.nextDue).toBeNull();
      expect(chore.paused).toEqual({ until: null, completeAnyway: expect.objectContaining({ dueDate: "2026-03-02", timeSlot: null }) });
      const res = await h.standard.post(`${h.chores}/${h.chore.id}/complete-early`, {
        idempotencyKey: "e1",
        dueDate: chore.paused.completeAnyway.dueDate,
        timeSlot: null,
      });
      expect(await res.json()).toMatchObject({ outcome: "completed", completion: { dueDate: "2026-03-02", early: true } });

      expect((await h.admin.post(`${h.pauses}/${pause.id}/end`)).status).toBe(200);
      expect(await h.statuses()).toEqual([
        ["2026-03-01", "open"],
        ["2026-03-02", "completed"],
      ]);
    });

    test("Complete anyway records an Early Completion on the next Occurrence, keeping the Pause's Skips", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await withTag();
      await h.pause({ choreId: h.chore.id, endDate: "2026-03-03" });
      const paused = await (await h.scan(h.standard, "s1")).json();

      const res = await h.standard.post(`/api/scan/${h.tag.id}/complete-early`, {
        idempotencyKey: "e1",
        dueDate: paused.nextDue.dueDate,
        timeSlot: paused.nextDue.timeSlot,
      });

      expect(await res.json()).toMatchObject({
        outcome: "completed",
        completion: { dueDate: "2026-03-04", early: true, method: "nfc", tagId: h.tag.id, completer: { displayName: "Sam" } },
      });
      t.clock.set("2026-03-05T09:00:00Z");
      expect(await h.statuses()).toEqual([
        ["2026-03-01", "skipped"],
        ["2026-03-02", "skipped"],
        ["2026-03-03", "skipped"],
        ["2026-03-04", "completed"],
        ["2026-03-05", "open"],
      ]);
    });
  });
});

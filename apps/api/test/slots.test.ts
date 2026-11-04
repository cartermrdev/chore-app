import { describe, expect, test } from "bun:test";
import { useTestApp } from "./harness";

const daily = (slots?: unknown) => ({
  kind: "fixed",
  rule: { type: "every_n_days", n: 1 },
  ...(slots === undefined ? {} : { slots }),
});
const morningEvening = [
  { name: "Morning", start: "06:00" },
  { name: "Evening", start: "17:00" },
];

describe("Time Slots and Late", () => {
  // Winter in London, so local time is UTC.
  const t = useTestApp({ now: "2026-01-05T05:00:00Z" });

  async function household(schedule: unknown) {
    t.clock.set("2026-01-05T05:00:00Z");
    const { person, household } = await t.seed({ timeZone: "Europe/London", adminName: "Alex" });
    const admin = await t.signIn(person.id);
    const base = `/api/households/${household.id}/chores`;
    const res = await admin.post(base, { name: "Feed the cat", schedule });
    expect(res.status).toBe(201);
    const chore = await res.json();
    return { admin, household, base, chore, adminId: person.id };
  }

  test("each Time Slot produces its own Occurrence, due at the slot's start", async () => {
    const { admin, base, chore } = await household(daily(morningEvening));

    t.clock.set("2026-01-05T18:00:00Z");
    const detail = await (await admin.get(`${base}/${chore.id}`)).json();

    expect(detail.schedule.slots).toMatchObject(morningEvening);
    expect(detail.occurrences).toMatchObject([
      { dueDate: "2026-01-05", timeSlot: "Morning", dueTime: "2026-01-05T06:00:00.000Z", windowEnd: "2026-01-05T17:00:00.000Z", status: "missed" },
      { dueDate: "2026-01-05", timeSlot: "Evening", dueTime: "2026-01-05T17:00:00.000Z", windowEnd: "2026-01-06T06:00:00.000Z", status: "open" },
    ]);
  });

  test("a completion at 14:00 with Morning and Evening slots completes the Morning Occurrence, Late", async () => {
    const { admin, base, chore } = await household(daily(morningEvening));

    t.clock.set("2026-01-05T14:00:00Z");
    const res = await admin.post(`${base}/${chore.id}/complete`, { idempotencyKey: "k" });

    expect(await res.json()).toMatchObject({
      outcome: "completed",
      completion: { timeSlot: "Morning", late: true },
      nextDue: { dueDate: "2026-01-05", dueTime: "2026-01-05T17:00:00.000Z" },
    });
  });

  test("a Time Slot completion within the 30-minute Grace Period is On time, and after it is Late", async () => {
    const { admin, base, chore } = await household(daily(morningEvening));

    t.clock.set("2026-01-05T06:30:00Z");
    const onTime = await (await admin.post(`${base}/${chore.id}/complete`, { idempotencyKey: "a" })).json();
    t.clock.set("2026-01-05T17:30:01Z");
    const late = await (await admin.post(`${base}/${chore.id}/complete`, { idempotencyKey: "b" })).json();

    expect(onTime).toMatchObject({ outcome: "completed", completion: { timeSlot: "Morning", late: false } });
    expect(late).toMatchObject({ outcome: "completed", completion: { timeSlot: "Evening", late: true } });
  });

  test("a day-level Occurrence is Late only once its due date has ended in the Household's time zone", async () => {
    t.clock.set("2026-07-01T09:00:00Z");
    const { person, household } = await t.seed({ timeZone: "Europe/London" });
    const admin = await t.signIn(person.id);
    const base = `/api/households/${household.id}/chores`;
    const every2 = { kind: "fixed", rule: { type: "every_n_days", n: 2 } };
    const a = await (await admin.post(base, { name: "A", schedule: every2 })).json();
    const b = await (await admin.post(base, { name: "B", schedule: every2 })).json();

    // 23:59 BST on the due date is still on time; 00:00 BST the next day is Late.
    t.clock.set("2026-07-01T22:59:00Z");
    const onTime = await (await admin.post(`${base}/${a.id}/complete`, { idempotencyKey: "a" })).json();
    t.clock.set("2026-07-01T23:00:01Z");
    const late = await (await admin.post(`${base}/${b.id}/complete`, { idempotencyKey: "b" })).json();

    expect(onTime).toMatchObject({ outcome: "completed", completion: { dueDate: "2026-07-01", late: false } });
    expect(late).toMatchObject({ outcome: "completed", completion: { dueDate: "2026-07-01", late: true } });
  });

  test("an Admin edits and removes Time Slots; the change applies from the next Occurrence", async () => {
    const { admin, base, chore } = await household(daily(morningEvening));
    t.clock.set("2026-01-05T07:00:00Z");
    await admin.get(`${base}/${chore.id}`); // Morning is now stored and Open

    const edited = await admin.patch(`${base}/${chore.id}`, {
      schedule: daily([{ name: "Midday", start: "12:00" }]),
    });
    expect(edited.status).toBe(200);
    expect((await edited.json()).schedule.slots).toEqual([{ name: "Midday", start: "12:00", assigneeId: null }]);

    // The stored Morning keeps its Window (until 17:00); Midday starts on the next day.
    t.clock.set("2026-01-06T13:00:00Z");
    let detail = await (await admin.get(`${base}/${chore.id}`)).json();
    expect(detail.occurrences.map((o: any) => [o.dueDate, o.timeSlot, o.status])).toEqual([
      ["2026-01-05", "Morning", "missed"],
      ["2026-01-06", "Midday", "open"],
    ]);

    // Removing the slots goes back to day-level Occurrences once the current Midday Window
    // (until 01-07 12:00) has ended, so the first day-level one is due on 01-08.
    await admin.patch(`${base}/${chore.id}`, { schedule: daily([]) });
    t.clock.set("2026-01-08T13:00:00Z");
    detail = await (await admin.get(`${base}/${chore.id}`)).json();
    expect(detail.schedule.slots).toBeUndefined();
    expect(detail.occurrences.map((o: any) => [o.dueDate, o.timeSlot, o.status]).slice(1)).toEqual([
      ["2026-01-06", "Midday", "missed"],
      ["2026-01-08", null, "open"],
    ]);
  });

  test("invalid Time Slots are rejected", async () => {
    const { admin, base } = await household(daily());
    for (const slots of [
      [{ name: "", start: "06:00" }],
      [{ name: "A", start: "25:00" }],
      [{ name: "A", start: "06:00" }, { name: "A", start: "07:00" }],
    ]) {
      expect((await admin.post(base, { name: "X", schedule: daily(slots) })).status).toBe(400);
    }
  });
});

describe("Assignees", () => {
  const t = useTestApp({ now: "2026-01-05T05:00:00Z" });

  async function household() {
    t.clock.set("2026-01-05T05:00:00Z");
    const { person, household } = await t.seed({ timeZone: "Europe/London", adminName: "Alex" });
    const admin = await t.signIn(person.id);
    const sam = await t.addPerson(household.id, { displayName: "Sam", role: "standard" });
    const kim = await t.addPerson(household.id, { displayName: "Kim", role: "standard" });
    const base = `/api/households/${household.id}/chores`;
    return { admin, household, base, sam, kim };
  }

  test("an Assignee per Time Slot is copied onto each of that slot's Occurrences", async () => {
    const { admin, base, sam } = await household();
    const chore = await (await admin.post(base, {
      name: "Feed the cat",
      schedule: daily([
        { name: "Morning", start: "06:00", assigneeId: sam.id },
        { name: "Evening", start: "17:00" },
      ]),
    })).json();

    t.clock.set("2026-01-06T07:00:00Z");
    const detail = await (await admin.get(`${base}/${chore.id}`)).json();

    expect(detail.occurrences.map((o: any) => [o.dueDate, o.timeSlot, o.assignee])).toEqual([
      ["2026-01-05", "Morning", { id: sam.id, displayName: "Sam" }],
      ["2026-01-05", "Evening", null],
      ["2026-01-06", "Morning", { id: sam.id, displayName: "Sam" }],
    ]);
  });

  test("a Chore without slots has an optional Assignee, copied onto each new Occurrence; a change applies from the next one", async () => {
    const { admin, base, sam, kim } = await household();
    const created = await admin.post(base, { name: "Dishes", schedule: daily(), assigneeId: sam.id });
    expect(created.status).toBe(201);
    const chore = await created.json();
    expect(chore.assignee).toEqual({ id: sam.id, displayName: "Sam" });

    t.clock.set("2026-01-05T09:00:00Z");
    await admin.get(`${base}/${chore.id}`); // the 01-05 Occurrence is stored
    const patched = await admin.patch(`${base}/${chore.id}`, { assigneeId: kim.id });
    expect(patched.status).toBe(200);
    expect((await patched.json()).assignee).toEqual({ id: kim.id, displayName: "Kim" });

    t.clock.set("2026-01-06T09:00:00Z");
    const { chores } = await (await admin.get(base)).json();
    expect(chores[0]).toMatchObject({
      assignee: { displayName: "Kim" },
      currentOccurrence: { dueDate: "2026-01-06", assignee: { displayName: "Kim" } },
    });
    const detail = await (await admin.get(`${base}/${chore.id}`)).json();
    expect(detail.occurrences.map((o: any) => o.assignee?.displayName ?? null)).toEqual(["Sam", "Kim"]);

    // Unassigning: anyone can pick it up from the next Occurrence.
    await admin.patch(`${base}/${chore.id}`, { assigneeId: null });
    t.clock.set("2026-01-07T09:00:00Z");
    const after = await (await admin.get(`${base}/${chore.id}`)).json();
    expect(after.assignee).toBeNull();
    expect(after.occurrences.at(-1).assignee).toBeNull();
  });

  test("a Time Slot leaves its Occurrences unassigned even when the Chore has an Assignee", async () => {
    const { admin, base, sam } = await household();
    const chore = await (await admin.post(base, {
      name: "Feed the cat",
      assigneeId: sam.id,
      schedule: daily([{ name: "Morning", start: "06:00" }]),
    })).json();

    t.clock.set("2026-01-05T07:00:00Z");
    const detail = await (await admin.get(`${base}/${chore.id}`)).json();
    expect(detail.occurrences[0]).toMatchObject({ timeSlot: "Morning", assignee: null });
  });

  test("an Assignee must be a current Person in the Household", async () => {
    const { admin, base } = await household();
    const other = await t.seed({ timeZone: "Europe/London" });

    for (const body of [
      { name: "X", schedule: daily(), assigneeId: other.person.id },
      { name: "X", schedule: daily(), assigneeId: "not-a-uuid" },
      { name: "X", schedule: daily(), assigneeId: 5 },
      { name: "X", schedule: daily([{ name: "Morning", start: "06:00", assigneeId: other.person.id }]) },
    ]) {
      expect((await admin.post(base, body)).status).toBe(400);
    }
    const chore = await (await admin.post(base, { name: "Y", schedule: daily() })).json();
    expect((await admin.patch(`${base}/${chore.id}`, { assigneeId: other.person.id })).status).toBe(400);
  });

  test("anyone in the Household can complete an Occurrence assigned to someone else, and is credited", async () => {
    const { admin, base, sam, kim } = await household();
    const chore = await (await admin.post(base, { name: "Dishes", schedule: daily(), assigneeId: sam.id })).json();
    const kimClient = await t.signIn(kim.id);

    t.clock.set("2026-01-05T09:00:00Z");
    const res = await kimClient.post(`${base}/${chore.id}/complete`, { idempotencyKey: "k" });

    expect(await res.json()).toMatchObject({
      outcome: "completed",
      completion: { completer: { id: kim.id, displayName: "Kim" }, assignee: { id: sam.id, displayName: "Sam" } },
    });
    const detail = await (await admin.get(`${base}/${chore.id}`)).json();
    expect(detail.occurrences[0]).toMatchObject({
      status: "completed",
      assignee: { displayName: "Sam" },
      completion: { completer: { displayName: "Kim" } },
    });
  });

  test("an Assignee whose Membership has ended is not copied onto new Occurrences", async () => {
    const { admin, base, sam, household: h } = await household();
    const chore = await (await admin.post(base, { name: "Dishes", schedule: daily(), assigneeId: sam.id })).json();
    // No API ends a Membership yet (#17).
    await t.db`UPDATE memberships SET ended_at = ${t.clock.now()} WHERE person_id = ${sam.id} AND household_id = ${h.id}`;

    t.clock.set("2026-01-05T09:00:00Z");
    const detail = await (await admin.get(`${base}/${chore.id}`)).json();
    expect(detail.occurrences[0].assignee).toBeNull();
  });
});

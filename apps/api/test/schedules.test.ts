import { describe, expect, test } from "bun:test";
import { useTestApp } from "./harness";

const weekdays = (days: number[], n = 1, startDate?: string) => ({
  kind: "fixed",
  ...(startDate ? { startDate } : {}),
  rule: { type: "weekdays", weekdays: days, n },
});
const monthly = (day: number, startDate?: string) => ({
  kind: "fixed",
  ...(startDate ? { startDate } : {}),
  rule: { type: "monthly", day },
});

describe("weekday and monthly Fixed Schedules", () => {
  // 2026-03-02 is a Monday.
  const t = useTestApp({ now: "2026-03-02T09:00:00Z" });

  test("an Admin creates a Chore due every Thursday, and it is next due on Thursday", async () => {
    t.clock.set("2026-03-02T09:00:00Z");
    const { person, household } = await t.seed({ timeZone: "Europe/London" });
    const admin = await t.signIn(person.id);
    const base = `/api/households/${household.id}/chores`;

    const res = await admin.post(base, { name: "Bins", schedule: weekdays([4]) });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      schedule: { kind: "fixed", startDate: "2026-03-02", rule: { type: "weekdays", weekdays: [4], n: 1 } },
    });
    const { chores } = await (await admin.get(base)).json();
    expect(chores[0]).toMatchObject({ currentOccurrence: null, nextDue: { dueDate: "2026-03-05" } });
  });

  test("an Admin creates a monthly Chore on day 31, which falls on the last day of a short month", async () => {
    t.clock.set("2026-04-02T09:00:00Z");
    const { person, household } = await t.seed({ timeZone: "Europe/London" });
    const admin = await t.signIn(person.id);
    const base = `/api/households/${household.id}/chores`;

    const res = await admin.post(base, { name: "Filter", schedule: monthly(31) });

    expect(res.status).toBe(201);
    const { chores } = await (await admin.get(base)).json();
    expect(chores[0]).toMatchObject({ nextDue: { dueDate: "2026-04-30" } });
  });

  test("invalid weekday and monthly rules are rejected", async () => {
    const { person, household } = await t.seed();
    const admin = await t.signIn(person.id);
    const base = `/api/households/${household.id}/chores`;

    for (const schedule of [
      weekdays([]),
      weekdays([0]),
      weekdays([8]),
      weekdays([1, 1]),
      weekdays([1], 0),
      { kind: "fixed", rule: { type: "weekdays", n: 1 } },
      monthly(0),
      monthly(32),
      monthly(1.5),
    ]) {
      const res = await admin.post(base, { name: "X", schedule });
      expect(res.status).toBe(400);
    }
  });
});

describe("the Household time zone", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  test("an Admin changes it; stored Occurrences keep their times and new ones follow local time in the new zone", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const { person, household } = await t.seed({ timeZone: "Europe/London" });
    const admin = await t.signIn(person.id);
    const base = `/api/households/${household.id}/chores`;
    const chore = await (await admin.post(base, { name: "Dishes", schedule: { kind: "fixed", rule: { type: "every_n_days", n: 1 } } })).json();
    const first = (await (await admin.get(`${base}/${chore.id}`)).json()).occurrences[0];

    const res = await admin.patch(`/api/households/${household.id}`, { timeZone: "America/New_York" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: household.id, timeZone: "America/New_York" });

    const me = await (await admin.get("/api/me")).json();
    expect(me.memberships[0].household.timeZone).toBe("America/New_York");

    t.clock.set("2026-03-02T09:00:00Z"); // 04:00 in New York
    const detail = await (await admin.get(`${base}/${chore.id}`)).json();
    expect(detail.occurrences[0]).toEqual({ ...first, status: "missed" }); // its Window (London) has closed
    expect(detail.occurrences.slice(1).map((o: any) => [o.dueDate, o.windowStart, o.dueTime])).toEqual([
      ["2026-03-02", "2026-03-02T05:00:00.000Z", "2026-03-03T05:00:00.000Z"],
    ]);
  });

  test("only an Admin can change it, and only to a real time zone", async () => {
    const { person, household } = await t.seed({ timeZone: "Europe/London" });
    const admin = await t.signIn(person.id);
    const sam = await t.signIn((await t.addPerson(household.id, { role: "standard" })).id);
    const outsider = await t.signIn((await t.seed()).person.id);
    const url = `/api/households/${household.id}`;

    expect((await sam.patch(url, { timeZone: "Europe/Paris" })).status).toBe(403);
    expect((await outsider.patch(url, { timeZone: "Europe/Paris" })).status).toBe(404);
    for (const timeZone of [undefined, "", "Mars/Olympus", 5]) {
      expect((await admin.patch(url, { timeZone })).status).toBe(400);
    }
    const me = await (await admin.get("/api/me")).json();
    expect(me.memberships[0].household.timeZone).toBe("Europe/London");
  });
});

describe("editing a Schedule", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });
  const daily = { kind: "fixed", rule: { type: "every_n_days", n: 1 } };

  async function adminWithChore(schedule: unknown) {
    const { person, household } = await t.seed({ timeZone: "Europe/London" });
    const admin = await t.signIn(person.id);
    const base = `/api/households/${household.id}/chores`;
    const chore = await (await admin.post(base, { name: "Dishes", schedule })).json();
    return { admin, household, chore, base, url: `${base}/${chore.id}` };
  }

  const summary = (o: any) => ({
    dueDate: o.dueDate,
    status: o.status,
    windowStart: o.windowStart,
    dueTime: o.dueTime,
    windowEnd: o.windowEnd,
    completion: o.completion,
  });

  test("the current Open Occurrence and past Occurrences keep their dates; later ones follow the new Schedule", async () => {
    t.clock.set("2026-03-01T09:00:00Z"); // Sunday
    const { admin, url } = await adminWithChore(daily);
    await admin.post(`${url}/complete`, { idempotencyKey: "k1" });
    t.clock.set("2026-03-03T09:00:00Z"); // Tuesday: 03-01 Completed, 03-02 Missed, 03-03 Open
    const before = (await (await admin.get(url)).json()).occurrences.map(summary);
    expect(before.map((o: any) => [o.dueDate, o.status])).toEqual([
      ["2026-03-01", "completed"],
      ["2026-03-02", "missed"],
      ["2026-03-03", "open"],
    ]);

    const res = await admin.patch(url, { schedule: weekdays([4]) }); // every Thursday
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      schedule: { startDate: "2026-03-03", rule: { type: "weekdays", weekdays: [4] } },
    });

    const after = await (await admin.get(url)).json();
    expect(after.occurrences.map(summary)).toEqual(before);
    expect(after.nextDue.dueDate).toBe("2026-03-03");

    t.clock.set("2026-03-04T09:00:00Z"); // Wednesday: not a Thursday, nothing new
    let detail = await (await admin.get(url)).json();
    expect(detail.occurrences.map((o: any) => [o.dueDate, o.status])).toEqual([
      ["2026-03-01", "completed"],
      ["2026-03-02", "missed"],
      ["2026-03-03", "missed"],
    ]);
    expect(detail.nextDue.dueDate).toBe("2026-03-05");

    t.clock.set("2026-03-05T09:00:00Z");
    detail = await (await admin.get(url)).json();
    expect(detail.occurrences.at(-1)).toMatchObject({
      dueDate: "2026-03-05",
      status: "open",
      windowEnd: "2026-03-12T00:00:00.000Z",
    });
    expect(detail.occurrences.slice(0, 2).map(summary)).toEqual(before.slice(0, 2));
  });

  test("a new Schedule cannot open an Occurrence inside the current Window", async () => {
    t.clock.set("2026-03-05T09:00:00Z"); // Thursday
    const { admin, url } = await adminWithChore(weekdays([4]));
    const current = (await (await admin.get(url)).json()).occurrences[0];
    expect(current).toMatchObject({ dueDate: "2026-03-05", windowEnd: "2026-03-12T00:00:00.000Z" });

    expect((await admin.patch(url, { schedule: daily })).status).toBe(200);
    t.clock.set("2026-03-08T09:00:00Z");
    let detail = await (await admin.get(url)).json();
    expect(detail.occurrences.map(summary)).toEqual([summary(current)]);
    expect(detail.nextDue.dueDate).toBe("2026-03-05");

    t.clock.set("2026-03-12T09:00:00Z");
    detail = await (await admin.get(url)).json();
    expect(detail.occurrences.map((o: any) => [o.dueDate, o.status, o.windowEnd])).toEqual([
      ["2026-03-05", "missed", "2026-03-12T00:00:00.000Z"],
      ["2026-03-12", "open", "2026-03-13T00:00:00.000Z"],
    ]);
  });

  test("an Admin can rename a Chore without touching its Schedule", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const { admin, url, chore } = await adminWithChore(daily);
    const res = await admin.patch(url, { name: "Load the dishwasher" });
    expect(res.status).toBe(200);
    expect(await (await admin.get(url)).json()).toMatchObject({ name: "Load the dishwasher", schedule: chore.schedule });
  });

  test("only Admins can edit, and invalid edits are rejected", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const { admin, household, url, base, chore } = await adminWithChore(daily);
    const sam = await t.signIn((await t.addPerson(household.id, { role: "standard" })).id);

    expect((await sam.patch(url, { schedule: monthly(1) })).status).toBe(403);
    expect((await admin.patch(url, { schedule: monthly(40) })).status).toBe(400);
    expect((await admin.patch(url, { name: " " })).status).toBe(400);
    expect((await admin.patch(`${base}/00000000-0000-0000-0000-000000000000`, { name: "X" })).status).toBe(404);
    expect((await (await admin.get(url)).json()).schedule).toEqual(chore.schedule);
  });
});

import { describe, expect, test } from "bun:test";
import type { Schedule } from "../schedule.ts";
import { UnusableSchedule, clockWords, describeSchedule, dueSlot, nextSlot, runTitle } from "../schedule.ts";

/** A moment on the clock the user reads: Thursday 12 November 2026. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);
const words = (slot: Date | null) => (slot === null ? null : `${slot.getDate()} ${slot.getHours()}:${slot.getMinutes()}`);

describe("the presets", () => {
  test("run at their time every day, and skip to tomorrow's once it has passed", () => {
    const daily = { kind: "daily", time: "07:30" } as const;
    expect(words(nextSlot(daily, at(12, 6)))).toBe("12 7:30");
    expect(words(nextSlot(daily, at(12, 7, 30)))).toBe("13 7:30");
    expect(words(nextSlot(daily, at(12, 23, 59)))).toBe("13 7:30");
  });

  test("keep weekdays out of the weekend", () => {
    const weekdays = { kind: "weekdays", time: "09:00" } as const;
    expect(words(nextSlot(weekdays, at(12, 8)))).toBe("12 9:0");
    expect(words(nextSlot(weekdays, at(13, 10)))).toBe("16 9:0");
    expect(words(nextSlot(weekdays, at(14, 10)))).toBe("16 9:0");
    expect(words(nextSlot(weekdays, at(16, 8)))).toBe("16 9:0");
    expect(words(nextSlot(weekdays, at(16, 10)))).toBe("17 9:0");
  });

  test("take the days of the week the user ticks, in any order", () => {
    const days: Schedule = { kind: "days", days: [3, 0], time: "18:00" };
    expect(words(nextSlot(days, at(12, 12)))).toBe("15 18:0");
    expect(words(nextSlot(days, at(15, 19)))).toBe("18 18:0");
  });

  test("step through the day from midnight, on the wall clock", () => {
    const everySix = { kind: "hours", every: 6 } as const;
    expect(words(nextSlot(everySix, at(12, 1)))).toBe("12 6:0");
    expect(words(nextSlot(everySix, at(12, 18, 30)))).toBe("13 0:0");
    expect(words(nextSlot({ kind: "hours", every: 1 }, at(12, 23, 30))))
      .toBe("13 0:0");
  });

  test("say themselves in a few words", () => {
    expect(describeSchedule({ kind: "daily", time: "07:30" })).toBe("Every day at 07:30");
    expect(describeSchedule({ kind: "weekdays", time: "09:00" })).toBe("Weekdays at 09:00");
    expect(describeSchedule({ kind: "days", days: [1, 3], time: "18:00" })).toBe("Mon, Wed at 18:00");
    expect(describeSchedule({ kind: "days", days: [0, 1, 2, 3, 4, 5, 6], time: "18:00" })).toBe("every day at 18:00");
    expect(describeSchedule({ kind: "hours", every: 1 })).toBe("Every hour");
    expect(describeSchedule({ kind: "hours", every: 6 })).toBe("Every 6 hours");
    expect(describeSchedule({ kind: "cron", cron: " 30 7 * * 1-5 " })).toBe('Cron "30 7 * * 1-5"');
  });
});

describe("a cron line", () => {
  test("reads like the presets when it says the same thing", () => {
    expect(words(nextSlot({ kind: "cron", cron: "30 7 * * *" }, at(12, 6)))).toBe("12 7:30");
    expect(words(nextSlot({ kind: "cron", cron: "0 9 * * 1-5" }, at(14, 10)))).toBe("16 9:0");
    expect(words(nextSlot({ kind: "cron", cron: "*/15 * * * *" }, at(12, 10, 3)))).toBe("12 10:15");
  });

  test("takes lists, steps, names, and Sunday as 0 or 7", () => {
    expect(words(nextSlot({ kind: "cron", cron: "0 6,18 * * *" }, at(12, 7)))).toBe("12 18:0");
    expect(words(nextSlot({ kind: "cron", cron: "0 8 * * mon,fri" }, at(12, 9)))).toBe("13 8:0");
    expect(words(nextSlot({ kind: "cron", cron: "0 8 * * 7" }, at(12, 9)))).toBe("15 8:0");
    expect(words(nextSlot({ kind: "cron", cron: "0 9 1 jan *" }, at(12, 10)))).toBe("1 9:0");
  });

  test("holds when a day of the month or a day of the week fits, as cron does", () => {
    expect(words(nextSlot({ kind: "cron", cron: "0 12 1 * 1" }, at(12, 13)))).toBe("16 12:0");
  });

  test("says what is wrong with one that isn't five fields or holds a number out of range", () => {
    expect(() => nextSlot({ kind: "cron", cron: "30 7 * *" }, at(12, 6))).toThrow('"30 7 * *" is not five fields');
    expect(() => nextSlot({ kind: "cron", cron: "70 7 * * *" }, at(12, 6))).toThrow("70 in \"70\" is not between 0 and 59");
    expect(() => nextSlot({ kind: "cron", cron: "0 0 * * mon-tue-wed" }, at(12, 6))).toThrow("is not a number or a range");
    expect(() => nextSlot({ kind: "cron", cron: "5-1 * * * *" }, at(12, 6))).toThrow("counts backwards");
  });

  test("gives up on one that never comes, rather than searching forever", () => {
    expect(nextSlot({ kind: "cron", cron: "0 0 30 2 *" }, at(12, 6))).toBeNull();
  });
});

describe("a routine that missed its slots", () => {
  test("runs once, on the newest slot, when its time passed while the Mac slept", () => {
    const weekdays = { kind: "weekdays", time: "09:00" } as const;
    const lastFired = at(13, 9);
    const monday = at(16, 10);
    expect(words(dueSlot(weekdays, lastFired, monday))).toBe("16 9:0");
    expect(dueSlot(weekdays, at(16, 9), monday)).toBeNull();
  });

  test("runs its first slot as soon as it is due, without a past to compare with", () => {
    expect(words(dueSlot({ kind: "daily", time: "07:30" }, null, at(12, 7, 30)))).toBe("12 7:30");
    expect(dueSlot({ kind: "daily", time: "07:30" }, null, at(12, 7, 29))).toBeNull();
  });

  test("refuses a time that isn't one", () => {
    expect(() => dueSlot({ kind: "daily", time: "7.30" }, null, at(12, 8))).toThrow(UnusableSchedule);
    expect(() => nextSlot({ kind: "hours", every: 0 }, at(12, 8))).toThrow("between 1 and 24");
  });
});

test("a run is titled after its routine and dated", () => {
  expect(runTitle("Check e2e results", at(12, 7, 30))).toBe("Check e2e results · 12 Nov");
  expect(clockWords(at(12, 7, 5))).toBe("07:05");
});

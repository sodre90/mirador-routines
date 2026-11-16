/**
 * When a routine runs. The presets cover the everyday shapes; a cron line covers the rest, and its slots are read the way
 * the computer's clock shows them, so "30 7 * * *" is 07:30 in the user's own time zone.
 */
export type Schedule =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "days"; days: number[]; time: string }
  | { kind: "hours"; every: number }
  | { kind: "cron"; cron: string };

export const SHORT_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTHS_ABBREVIATED = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** How far ahead to look for a slot that never comes: four years of minutes. */
const LOOK_AHEAD_MS = 4 * 366 * 24 * HOUR_MS;

export class UnusableSchedule extends Error {}

const startOfDay = (at: Date) => {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day;
};

const daysAfter = (day: Date, days: number) => {
  const later = new Date(day);
  later.setDate(later.getDate() + days);
  return later;
};

/** "07:30" as minutes past midnight; throws for anything that isn't a time of day. */
export function minutesOfTime(time: string): number {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (!match) throw new UnusableSchedule(`${time} is not a time like 07:30.`);
  return Number(match[1]) * 60 + Number(match[2]);
}

const atMinutes = (day: Date, minutes: number) => {
  const time = new Date(day);
  time.setMinutes(minutes);
  return time;
};

/** The slot the preset puts on this day, or null when the preset skips the day. */
function presetSlotOn(schedule: Exclude<Schedule, { kind: "cron" | "hours" }>, day: Date): Date | null {
  const minutes = minutesOfTime(schedule.time);
  if (schedule.kind === "daily") return atMinutes(day, minutes);
  const weekday = day.getDay();
  if (schedule.kind === "weekdays") return weekday >= 1 && weekday <= 5 ? atMinutes(day, minutes) : null;
  return schedule.days.includes(weekday) ? atMinutes(day, minutes) : null;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].reduce(
  (names, name, index) => ({ ...names, [name]: index + 1 }),
  {} as Record<string, number>,
);
const DAY_NAMES = SHORT_DAY_NAMES.reduce(
  (names, name, index) => ({ ...names, [name]: index, [name.toLowerCase()]: index }),
  {} as Record<string, number>,
);

/** One cron value: a number, or the name of one where names are allowed. */
const cronValue = (value: string, low: number, high: number, names: Record<string, number>, field: string): number => {
  const number = names[value.toLowerCase()] ?? Number(value);
  if (!Number.isInteger(number) || number < low || number > (high === 6 ? 7 : high)) {
    throw new UnusableSchedule(`${value} in "${field}" is not between ${low} and ${high}.`);
  }
  return number;
};

/**
 * A cron field as the numbers it allows: `*`, lists, ranges and steps, with month and day names. Cron counts Sunday as
 * both 0 and 7, so 7 comes back as 0 where days are the field.
 */
function cronField(field: string, low: number, high: number, names: Record<string, number> = {}): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [span, step] = part.split("/");
    const every = step === undefined ? 1 : Number(step);
    if (!Number.isInteger(every) || every < 1) throw new UnusableSchedule(`${part} in "${field}" steps by nothing usable.`);
    const sides = span === "*" || span === "" ? [] : span.split("-");
    if (sides.length > 2) throw new UnusableSchedule(`${part} in "${field}" is not a number or a range.`);
    const from = sides.length === 0 ? low : cronValue(sides[0], low, high, names, field);
    const to = sides.length === 0 ? high : sides.length === 1 ? from : cronValue(sides[1], low, high, names, field);
    if (from > to) throw new UnusableSchedule(`${part} in "${field}" counts backwards.`);
    for (let value = from; value <= to; value += every) values.add(value === 7 && high === 6 ? 0 : value);
  }
  return values;
}

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  days: Set<number>;
  /** Whether the line left a day field as `*`, which decides how the two day fields combine. */
  daysOfMonthNamed: boolean;
  daysNamed: boolean;
}

/** Five cron fields, or a message saying which is wrong. */
export function parseCron(line: string): CronFields {
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 5) throw new UnusableSchedule(`"${line}" is not five fields like "30 7 * * 1-5".`);
  const [minutes, hours, daysOfMonth, months, days] = parts;
  return {
    minutes: cronField(minutes, 0, 59),
    hours: cronField(hours, 0, 23),
    daysOfMonth: cronField(daysOfMonth, 1, 31),
    months: cronField(months, 1, 12, MONTH_NAMES),
    days: cronField(days, 0, 6, DAY_NAMES),
    daysOfMonthNamed: daysOfMonth !== "*",
    daysNamed: days !== "*",
  };
}

/** Whether a cron line's slot falls on this minute of the clock; cron lets a day of the month or a day of the week hold. */
const cronHolds = (fields: CronFields, at: Date) => {
  const dayOfTheMonth = fields.daysOfMonth.has(at.getDate());
  const dayOfTheWeek = fields.days.has(at.getDay());
  // Cron lets either day field hold when both are named, and the named one when only one is.
  const dayHolds = fields.daysOfMonthNamed && fields.daysNamed ? dayOfTheMonth || dayOfTheWeek : dayOfTheMonth && dayOfTheWeek;
  return fields.minutes.has(at.getMinutes()) && fields.hours.has(at.getHours()) && fields.months.has(at.getMonth() + 1) && dayHolds;
};

/** The first slot strictly after `after` and no later than `until`, or null when the schedule has none by then: four years on, unless said. */
export function nextSlot(schedule: Schedule, after: Date, until = new Date(after.getTime() + LOOK_AHEAD_MS)): Date | null {
  const slot = firstSlotAfter(schedule, after, until);
  return slot !== null && slot.getTime() <= until.getTime() ? slot : null;
}

function firstSlotAfter(schedule: Schedule, after: Date, until: Date): Date | null {
  if (schedule.kind === "hours") {
    const every = schedule.every;
    if (!Number.isInteger(every) || every < 1 || every > 24) throw new UnusableSchedule(`every ${every} hours is not between 1 and 24.`);
    const midnight = startOfDay(after);
    const hoursSinceMidnight = Math.floor((after.getTime() - midnight.getTime()) / HOUR_MS);
    const slot = new Date(midnight);
    slot.setHours((Math.floor(hoursSinceMidnight / every) + 1) * every);
    return slot;
  }
  if (schedule.kind !== "cron") {
    for (let offset = 0; offset <= 8; offset++) {
      const slot = presetSlotOn(schedule, daysAfter(startOfDay(after), offset));
      if (slot && slot.getTime() > after.getTime()) return slot;
    }
    return null;
  }
  const fields = parseCron(schedule.cron);
  const from = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let at = from; at <= until.getTime(); at += MINUTE_MS) {
    if (cronHolds(fields, new Date(at))) return new Date(at);
  }
  return null;
}

/** The schedule's slots after `after` and no later than `until`, the first `most` of them, for the tab's week. */
export function slotsBetween(schedule: Schedule, after: Date, until: Date, most: number): Date[] {
  const slots: Date[] = [];
  for (let slot = nextSlot(schedule, after, until); slot !== null && slots.length < most; slot = nextSlot(schedule, slot, until)) slots.push(slot);
  return slots;
}

/**
 * The slot to run now: the newest one that came due since `lastFired`, or null when none did. Slots missed while the Mac
 * slept come back as one run of the newest, so a routine set for every morning runs once on Monday, not five times.
 */
export function dueSlot(schedule: Schedule, lastFired: Date | null, now: Date): Date | null {
  const since = lastFired ?? new Date(now.getTime() - MINUTE_MS);
  const due = nextSlot(schedule, since);
  return due !== null && due.getTime() <= now.getTime() ? due : null;
}

const dayList = (days: number[]) => (days.length === 7 ? "every day" : [...days].sort((a, b) => a - b).map((day) => SHORT_DAY_NAMES[day]).join(", "));

/** What the schedule says, in a few words, for the editor's preview and the routine's row. */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case "daily":
      return `Every day at ${schedule.time.trim()}`;
    case "weekdays":
      return `Weekdays at ${schedule.time.trim()}`;
    case "days":
      return `${dayList(schedule.days)} at ${schedule.time.trim()}`;
    case "hours":
      return schedule.every === 1 ? "Every hour" : `Every ${schedule.every} hours`;
    case "cron":
      return `Cron "${schedule.cron.trim()}"`;
  }
}

/** A routine's title for the conversation its run starts, dated so its runs tell apart in the sidebar. */
export const runTitle = (name: string, slot: Date) => `${name} · ${slot.getDate()} ${MONTHS_ABBREVIATED[slot.getMonth()]}`;

/** How a slot's time shows, as the clock the user reads. */
export const clockWords = (at: Date) =>
  `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

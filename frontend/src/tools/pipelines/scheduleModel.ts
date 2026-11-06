import type { ScheduleState, ScheduleTrigger } from "@/lib/api";
import { isHHMM } from "@/pipelines/steps/timeUtil";

// Pure helpers of the schedule editor (Phase 18, SPEC §3.3, §5.3). Days are
// Go's weekdays: 0 = Sunday … 6 = Saturday.

export const MAX_SCHEDULE_TIMES = 12;
export const DEFAULT_CATCH_UP = 30;
export const DEFAULT_TIME = "09:00";

/** Day chips in display order (Mon first). */
export const DAY_CHIPS: ReadonlyArray<{ day: number; label: string; long: string }> = [
  { day: 1, label: "Mon", long: "Monday" },
  { day: 2, label: "Tue", long: "Tuesday" },
  { day: 3, label: "Wed", long: "Wednesday" },
  { day: 4, label: "Thu", long: "Thursday" },
  { day: 5, label: "Fri", long: "Friday" },
  { day: 6, label: "Sat", long: "Saturday" },
  { day: 0, label: "Sun", long: "Sunday" },
];

export const WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];
export const EVERY_DAY: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

/** "If Toolbox wasn't running" choices, in minutes (0 = don't catch up). */
export const CATCH_UP_CHOICES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: "Don't catch up" },
  { value: 10, label: "10 min" },
  { value: 30, label: "30 min" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" },
  { value: 360, label: "6 hours" },
  { value: 720, label: "12 hours" },
];

/** A trigger with no nulls (Go's nil slices arrive as null). */
export interface Schedule {
  enabled: boolean;
  days: number[];
  times: string[];
  catchUpMin: number;
}

export function scheduleOf(s: ScheduleTrigger | null | undefined): Schedule {
  return { enabled: s?.enabled === true, days: [...(s?.days ?? [])], times: [...(s?.times ?? [])], catchUpMin: s?.catchUpMin ?? DEFAULT_CATCH_UP };
}

const sortDays = (days: readonly number[]): number[] => {
  const order = (d: number) => (d === 0 ? 7 : d);
  return [...new Set(days)].sort((a, b) => order(a) - order(b));
};

/** Adds or removes one day (kept in Mon…Sun order). */
export function toggleDay(days: readonly number[], day: number): number[] {
  return sortDays(days.includes(day) ? days.filter((d) => d !== day) : [...days, day]);
}

/** True when `days` holds exactly the days of `set`. */
export function sameDays(days: readonly number[], set: readonly number[]): boolean {
  return days.length === set.length && set.every((d) => days.includes(d));
}

/** Times sorted ascending, without repeats. */
export function sortTimes(times: readonly string[]): string[] {
  return [...new Set(times)].sort();
}

/** Adds a time (a sensible next one when none is given): at most 12, no repeats. */
export function addTime(times: readonly string[], time?: string): string[] {
  if (times.length >= MAX_SCHEDULE_TIMES) return sortTimes(times);
  if (time && isHHMM(time) && !times.includes(time)) return sortTimes([...times, time]);
  // The first free hour after the last time, else 09:00.
  const last = [...times].sort().pop();
  let h = last && isHHMM(last) ? (Number(last.slice(0, 2)) + 1) % 24 : Number(DEFAULT_TIME.slice(0, 2));
  for (let i = 0; i < 24; i++, h = (h + 1) % 24) {
    const t = `${String(h).padStart(2, "0")}:00`;
    if (!times.includes(t)) return sortTimes([...times, t]);
  }
  return sortTimes(times);
}

/** Changes the time at `index`; invalid text is kept as typed so the field can show its error. */
export function setTimeAt(times: readonly string[], index: number, time: string): string[] {
  return times.map((t, i) => (i === index ? time : t));
}

export function removeTimeAt(times: readonly string[], index: number): string[] {
  return times.filter((_, i) => i !== index);
}

/** Why the schedule can't be saved ("" = fine). A disabled schedule keeps whatever it has. */
export function scheduleProblem(s: Schedule): string {
  if (!s.enabled) return "";
  if (s.days.length === 0 || s.times.length === 0) return "Pick at least one day and one time";
  if (s.times.some((t) => !isHHMM(t))) return "Use times like 09:30 (24 hour)";
  if (new Set(s.times).size !== s.times.length) return "Each time can be listed once";
  if (s.times.length > MAX_SCHEDULE_TIMES) return `At most ${MAX_SCHEDULE_TIMES} times`;
  return "";
}

/** "Every day", "Weekdays", "Weekends" or "Mon, Wed". */
export function daysText(days: readonly number[]): string {
  if (sameDays(days, EVERY_DAY)) return "Every day";
  if (sameDays(days, WEEKDAYS)) return "Weekdays";
  if (sameDays(days, [0, 6])) return "Weekends";
  const names = sortDays(days).map((d) => DAY_CHIPS.find((c) => c.day === d)?.label ?? "");
  return names.join(", ") || "No days";
}

/** The Triggers panel's line for the schedule: "Weekdays 09:30, 17:00" (empty when off). */
export function scheduleSummary(s: Schedule): string {
  if (!s.enabled) return "";
  const times = sortTimes(s.times.filter(isHHMM));
  if (s.days.length === 0 || times.length === 0) return "Schedule (not set up)";
  return `${daysText(s.days)} ${times.join(", ")}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "Thu 09:30" in local time. */
export function nextFireText(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAY_SHORT[d.getDay()] ?? ""} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * What the pipeline card says about the schedule: "Next: Thu 09:30", the
 * schedule's message when it can't fire, or "" when there's no schedule.
 */
export function scheduleLine(enabled: boolean, state: Pick<ScheduleState, "active" | "message" | "next"> | null | undefined): string {
  if (!enabled || !state) return "";
  if (state.message) return state.message;
  if (state.active && state.next > 0) return `Next: ${nextFireText(state.next)}`;
  return "";
}

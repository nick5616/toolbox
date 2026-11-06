// Shared by the timing steps (Wait, Focus, Schedule): "HH:MM" 24 h local.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True for a valid "HH:MM" (24 h). */
export function isHHMM(s: string): boolean {
  return HHMM.test(s);
}

/** Rounds and clamps a number into [lo, hi]; anything else gives `d`. */
export function clampInt(v: unknown, lo: number, hi: number, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
}

/** "25 min", "1 h", "1 h 30 min". */
export function minutesText(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

/** The next moment (ms) the local clock reads `at` ("HH:MM"): today if still ahead, else tomorrow. 0 when invalid. */
export function nextClock(at: string, now: number = Date.now()): number {
  const m = HHMM.exec(at);
  if (!m) return 0;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() < now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

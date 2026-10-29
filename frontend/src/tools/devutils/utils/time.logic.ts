export type UnixUnit = "s" | "ms" | "us";

export const UNIT_FACTOR: Record<UnixUnit, number> = { s: 1000, ms: 1, us: 0.001 };

/** Guesses the unit of a Unix timestamp from its magnitude. */
export function guessUnit(n: number): UnixUnit {
  const a = Math.abs(n);
  if (a < 1e11) return "s";
  if (a < 1e14) return "ms";
  return "us";
}

export type ParsedTime = { ok: true; date: Date; unit: UnixUnit | "iso" } | { ok: false; message: string };

/** Accepts a Unix number (unit auto-detected unless given) or anything `Date` can parse as ISO 8601. */
export function parseTimeInput(text: string, unit: UnixUnit | "auto" = "auto"): ParsedTime {
  const t = text.trim();
  if (!t) return { ok: false, message: "Enter a timestamp or date" };
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    const u = unit === "auto" ? guessUnit(n) : unit;
    const d = new Date(n * UNIT_FACTOR[u]);
    if (Number.isNaN(d.getTime())) return { ok: false, message: "Timestamp is out of range" };
    return { ok: true, date: d, unit: u };
  }
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return { ok: false, message: "Not a recognised timestamp or ISO 8601 date" };
  return { ok: true, date: d, unit: "iso" };
}

export function toUnix(d: Date): { s: string; ms: string; us: string } {
  const ms = d.getTime();
  return { s: String(Math.floor(ms / 1000)), ms: String(ms), us: (BigInt(ms) * 1000n).toString() };
}

export function formatInZone(d: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).formatToParts(d);
    const g = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")} ${g("timeZoneName")}`;
  } catch {
    return "Unknown time zone";
  }
}

export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function zoneList(): string[] {
  const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  const zones = fn ? fn("timeZone") : [];
  const list = zones.length > 0 ? zones : ["UTC"];
  return list.includes("UTC") ? list : ["UTC", ...list];
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

export function relativeTime(d: Date, nowMs: number): string {
  const diffSec = Math.round((d.getTime() - nowMs) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diffSec) >= secs || unit === "second") return rtf.format(Math.round(diffSec / secs), unit);
  }
  return rtf.format(0, "second");
}

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** Binary units, one decimal: "4.2 MiB". Bytes are shown as integers. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  // Avoid "1024.0 KiB" from rounding up at a unit boundary.
  if (Number(value.toFixed(1)) >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** "4.2 MiB/s" */
export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "0:31", "12:05", "1:02:03". Negative and non-finite values clamp to 0. */
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** Timecode with tenths: "1:05.5", "0:00.0", "1:02:03.0". */
export function formatTimecode(seconds: number): string {
  const tenthsTotal = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10) : 0;
  const tenths = tenthsTotal % 10;
  return `${formatDuration(Math.floor(tenthsTotal / 10))}.${tenths}`;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "just now", "5m ago", "3h ago", "yesterday", "Oct 12" (with year when not the current one). */
export function formatRelativeTime(ms: number, now: number = Date.now()): string {
  const diff = now - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  const dayDelta = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (dayDelta <= 0) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (dayDelta === 1) return "yesterday";
  const date = new Date(ms);
  const label = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return date.getFullYear() === new Date(now).getFullYear() ? label : `${label}, ${date.getFullYear()}`;
}

/** Elapsed time between two Unix-ms instants (end defaults to now): "0:31". */
export function formatElapsed(startMs: number, endMs: number = Date.now()): string {
  return formatDuration(Math.max(0, endMs - startMs) / 1000);
}

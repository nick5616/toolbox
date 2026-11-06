import { CellStatus, WaitKind } from "@/lib/api";

// A cell waiting for a moment (Phase 18, SPEC §3.1, §5.3): Wait steps and Focus
// waits show "Until 17:30 · 42 min" and offer Continue now.

/** True for a cell that waits on the clock (or a focus session). */
export function isTimeWait(cell: { status: string; wait: string }): boolean {
  return cell.status === CellStatus.CellWaiting && cell.wait === WaitKind.WaitTime;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "17:30" in local time ("" when unknown). */
export function clockText(ms: number): string {
  if (!(ms > 0)) return "";
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** How long is left, rounded up to the minute: "42 min", "1 h 05 min", "under a minute" (empty when unknown). */
export function remainingText(until: number, now: number): string {
  if (!(until > 0)) return "";
  const left = until - now;
  if (left <= 60_000) return "under a minute";
  const min = Math.ceil(left / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${pad2(m)} min`;
}

/** "Until 17:30 · 42 min", "Until 17:30", or "Waiting" when the moment isn't known. A different day is named. */
export function timeWaitText(until: number, now: number): string {
  const clock = clockText(until);
  if (!clock) return "Waiting";
  const day = new Date(until).toDateString() === new Date(now).toDateString() ? "" : ` (${new Date(until).toLocaleDateString("en-US", { weekday: "short" })})`;
  const left = remainingText(until, now);
  return `Until ${clock}${day}${left ? ` · ${left}` : ""}`;
}

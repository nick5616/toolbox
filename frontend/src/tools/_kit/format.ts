import { formatBytes } from "@/lib/format";

export { formatBytes };

/** One date format for result rows: relative under a day ("5m ago", "3h ago"), then a short date ("Oct 12"; the year when it isn't the current one). */
export function formatResultDate(ms: number, now: number = Date.now()): string {
  if (!ms) return "";
  const diff = now - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const d = new Date(ms);
  const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.getFullYear() === new Date(now).getFullYear() ? label : `${label}, ${d.getFullYear()}`;
}

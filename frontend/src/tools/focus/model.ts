// Pure helpers for the Focus tool (SPEC §5.1): no React, no bindings calls.
import { FocusStrength, type FocusAllowRule, type FocusApp, type FocusBlockedApp, type FocusSession } from "@/lib/api";

export const PRESET_MINUTES = [25, 50, 90, 120] as const;
export const MAX_SESSION_MINUTES = 720;
export const MAX_EXTRA_RULES = 20;
export const STUDIO_PROFILE_NAME = "Studio";
/** Apps preselected in the first-open Studio profile when found (SPEC §4.3). */
export const STUDIO_APP_NAMES = ["Discord", "Claude", "Visual Studio Code", "Windows Terminal", "Ableton Live"] as const;

export const STRENGTH_OPTIONS = [
  { value: FocusStrength.StrengthSoft, label: "Soft", tip: "Ending early only needs a confirmation" },
  { value: FocusStrength.StrengthFirm, label: "Firm", tip: "Ending early needs a typed phrase and a 30 second wait" },
  { value: FocusStrength.StrengthStrict, label: "Strict", tip: "No early end; only an emergency unlock after 5 minutes" },
] as const;

export function strengthLabel(s: FocusStrength): string {
  return STRENGTH_OPTIONS.find((o) => o.value === s)?.label ?? "Firm";
}

export function strengthExplanation(s: FocusStrength): string {
  switch (s) {
    case FocusStrength.StrengthSoft:
      return "Ending early or allowing an app asks for one confirmation.";
    case FocusStrength.StrengthStrict:
      return "No early end. Only an emergency unlock: type a phrase, then wait 5 minutes while it keeps enforcing.";
    default:
      return "Ending early or allowing an app needs a typed phrase and a 30 second wait.";
  }
}

export const MAC_LINE =
  "On the Mac: apps opened from the Dock or Finder aren't tracked as children of the app you clicked in (folder rules cover them), there are no app icons, and the first polite close of each app needs your OK in macOS's Automation prompt.";

export const UNSUPPORTED_LINE = "Focus Lock works on Windows and macOS";

/** The friction phrase check: case and spacing exact, curly and straight apostrophes both accepted. */
export function normalizeApostrophes(s: string): string {
  return s.replace(/[‘’ʼ]/g, "'");
}

export function phraseMatches(typed: string, phrase: string): boolean {
  if (phrase === "") return true;
  return normalizeApostrophes(typed) === normalizeApostrophes(phrase);
}

/** Whole seconds left until `readyAt` (Unix ms); 0 when ready or unset. */
export function secondsUntil(readyAt: number, now: number): number {
  if (!readyAt || readyAt <= now) return 0;
  return Math.ceil((readyAt - now) / 1000);
}

/** "0:28", "4:59". */
export function formatMmSs(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "1 h 30 min", "42 min", "5 min". Under a minute rounds up to "1 min". */
export function formatLength(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")} min`;
}

/** Local "17:30" (24 h). */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Tue 14:05" for today-ish values, with the date for older ones. */
export function formatWhen(ms: number, now: number): string {
  const d = new Date(ms);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return `Today ${formatClock(ms)}`;
  const days = (now - ms) / 86400000;
  if (days >= 0 && days < 6) return `${WEEKDAYS[d.getDay()]} ${formatClock(ms)}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${formatClock(ms)}`;
}

export function weekdayName(ms: number): string {
  return WEEKDAYS[new Date(ms).getDay()] ?? "";
}

/** "HH:MM" → the next local time at that clock (today, else tomorrow); null if malformed. */
export function nextClockTime(hhmm: string, now: number): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Why an "Until" time can't start a session, or "" when fine (1 minute to 12 hours ahead). */
export function untilProblem(until: number | null, now: number): string {
  if (until == null) return "Enter a time like 17:30";
  const mins = (until - now) / 60000;
  if (mins < 1) return "Pick a time at least a minute from now";
  if (mins > MAX_SESSION_MINUTES) return "A session can last at most 12 hours";
  return "";
}

export function endReasonLabel(reason: string): string {
  switch (reason) {
    case "time":
      return "Finished";
    case "user":
      return "Ended early";
    case "emergency":
      return "Emergency unlock";
    case "pipeline":
      return "Ended by a pipeline";
    case "error":
      return "Stopped (engine error)";
    default:
      return reason || "Ended";
  }
}

export function blockedResultLabel(result: string): string {
  switch (result) {
    case "stopped":
      return "Stopped";
    case "closed":
      return "Closed";
    case "failed":
      return "Couldn't stop";
    case "wouldStop":
      return "Would stop";
    default:
      return result;
  }
}

/** "Steam ×4, Epic ×2" (top three), "" when none. */
export function blockedBreakdown(apps: readonly FocusBlockedApp[]): string {
  return [...apps]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((a) => `${a.name} ×${a.count}`)
    .join(", ");
}

/** The Ended line: "Focused 1 h 30 min · stopped 6 launches (Steam ×4, Epic ×2)". */
export function endedSummary(session: FocusSession, apps: readonly FocusBlockedApp[]): string {
  const end = session.endedAt || session.endsAt;
  const parts = [`Focused ${formatLength(Math.max(0, end - session.startedAt))}`];
  if (session.blocked > 0) {
    const n = session.blocked;
    const detail = blockedBreakdown(apps);
    parts.push(`stopped ${n} launch${n === 1 ? "" : "es"}${detail ? ` (${detail})` : ""}`);
  } else {
    parts.push("nothing needed stopping");
  }
  if (session.endReason && session.endReason !== "time") parts.push(endReasonLabel(session.endReason).toLowerCase());
  return parts.join(" · ");
}

export function programCount(n: number): string {
  return `${n} program${n === 1 ? "" : "s"}`;
}

export function appCount(n: number): string {
  return `${n} app${n === 1 ? "" : "s"}`;
}

/** Learn mode line: "Watching since Tue · 14 programs would have been stopped". */
export function learnSummary(since: number, count: number): string {
  const when = since ? `since ${weekdayName(since)}` : "";
  const what = count === 0 ? "nothing would have been stopped yet" : `${programCount(count)} would have been stopped`;
  return ["Watching", when].filter(Boolean).join(" ") + ` · ${what}`;
}

/** Final path segment (either separator), for "show file names not paths". */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Applies the rule's switch between folder and exe: the path stays, only the kind changes. */
export function withKind(rule: FocusAllowRule, kind: "folder" | "exe"): FocusAllowRule {
  return { ...rule, kind };
}

/** A rule for a path picked through Browse: an .exe/.app is an exe rule on it; anything else a folder rule. */
export function ruleForBrowsedPath(path: string, id: string): FocusAllowRule {
  const lower = path.toLowerCase();
  const exe = lower.endsWith(".exe") || lower.endsWith(".app") || lower.endsWith(".app/");
  const name = baseName(path).replace(/\.(exe|app)$/i, "");
  return { id, label: name || path, kind: exe ? "exe" : "folder", path, children: true };
}

/** The apps the first-open Studio profile preselects, matched by label (case-insensitive prefix). */
export function studioSuggestions(apps: readonly FocusApp[]): FocusApp[] {
  const out: FocusApp[] = [];
  const seen = new Set<string>();
  for (const want of STUDIO_APP_NAMES) {
    const hit = apps.find((a) => a.label.toLowerCase().startsWith(want.toLowerCase()) && !seen.has(a.rule.path));
    if (hit) {
      seen.add(hit.rule.path);
      out.push(hit);
    }
  }
  return out;
}

/** Order-preserving union of rules by (kind, path), case-insensitive on path. */
export function mergeRules(existing: readonly FocusAllowRule[], added: readonly FocusAllowRule[]): FocusAllowRule[] {
  const key = (r: FocusAllowRule) => `${r.kind}|${r.path.toLowerCase()}`;
  const seen = new Set(existing.map(key));
  const out = [...existing];
  for (const r of added) {
    if (seen.has(key(r))) continue;
    seen.add(key(r));
    out.push(r);
  }
  return out;
}

/** Paths (rule paths) as the picker's `chosen` list. */
export function rulePaths(rules: readonly FocusAllowRule[]): string[] {
  return rules.map((r) => r.path);
}

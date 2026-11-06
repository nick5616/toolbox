import { useEffect, useState } from "react";
import { toast } from "@/components";
import type { FocusBlockEvent, FocusState } from "@/lib/api";
import { on } from "@/lib/events";
import { FOCUS_MODULE_ID, isActive, subscribeFocus, useFocus } from "@/state/focus";
import { useUI } from "@/state/ui";

// Focus Lock in the shell (Phase 18): the top-bar pill's text, the focus
// toasts (blocked programs, resumed session) and the live subscription.

/** One toast per program per this long. */
export const BLOCK_TOAST_THROTTLE_MS = 60_000;
/** Blocked programs seen within this window share one toast. */
export const BLOCK_TOAST_SETTLE_MS = 400;
/** The page's start; a session that began before it was resumed. */
const APP_START = Date.now();

/** Minutes left, rounded up so it never says 0 while time remains. */
export function focusMinutesLeft(endsAtMs: number, nowMs: number): number {
  const d = endsAtMs - nowMs;
  return d <= 0 ? 0 : Math.ceil(d / 60_000);
}

/** "42 min" or "1 h 5 min". */
export function focusDuration(mins: number): string {
  if (mins >= 60) return mins % 60 === 0 ? `${mins / 60} h` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
  return `${mins} min`;
}

export function focusPillLabel(state: FocusState, nowMs: number): string | null {
  if (!isActive(state) || !state.session) return null;
  return `Focus · ${focusDuration(focusMinutesLeft(state.session.endsAt, nowMs))}`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** A program's display name ("Steam.exe" becomes "Steam"). */
export function programName(e: Pick<FocusBlockEvent, "name" | "path">): string {
  const raw = e.name || e.path.split(/[\\/]/).pop() || "a program";
  return raw.replace(/\.(exe|app)$/i, "");
}

function programKey(e: FocusBlockEvent): string {
  return (e.path || e.name).toLowerCase();
}

/** The toast text for the programs stopped together. */
export function blockedTitle(names: string[], until: number | null, dry: boolean): string {
  const verb = dry ? "Would stop" : "Stopped";
  const what = names.length <= 2 ? names.join(" and ") : `${names[0]} and ${names.length - 1} more`;
  return `${verb} ${what}${until ? ` · Focus until ${clock(until)}` : ""}`;
}

/** Throttle + batch for blocked events; `emit` gets one call per settled batch. */
export function createBlockedBatcher(emit: (names: string[], failed: string[]) => void, now: () => number = Date.now) {
  const last = new Map<string, number>();
  let names: string[] = [];
  let failed: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const n = names;
    const f = failed;
    names = [];
    failed = [];
    if (n.length || f.length) emit(n, f);
  };
  return {
    add(e: FocusBlockEvent) {
      if (e.sessionId === "") return; // learn mode stays silent
      if (!["stopped", "closed", "failed", "wouldStop"].includes(e.result)) return;
      const t = now();
      const key = programKey(e);
      const prev = last.get(key);
      if (prev !== undefined && t - prev < BLOCK_TOAST_THROTTLE_MS) return;
      last.set(key, t);
      const name = programName(e);
      if (e.result === "failed") {
        if (!failed.includes(name)) failed.push(name);
      } else if (!names.includes(name)) names.push(name);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, BLOCK_TOAST_SETTLE_MS);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Re-renders every `ms` so "42 min" stays right. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const RESUME_KEY = "focus.resumeChecked";

/** Shows the "Focus resumed" toast once per page load (StrictMode safe). */
export function maybeResumeToast(state: FocusState, nowMs: number, appStart: number = APP_START): boolean {
  if (!isActive(state) || !state.session || state.session.startedAt >= appStart) return false;
  try {
    if (sessionStorage.getItem(RESUME_KEY)) return false;
    sessionStorage.setItem(RESUME_KEY, "1");
  } catch {
    /* no storage: show it anyway */
  }
  const left = focusMinutesLeft(state.session.endsAt, nowMs);
  toast({ tone: "neutral", title: `Focus resumed, ${focusDuration(left)} left`, description: "Toolbox was closed during the session", duration: 8000 });
  return true;
}

/** Keeps the focus store live app-wide and raises the focus toasts. */
export function useFocusNotices(): void {
  useEffect(() => {
    const unsub = subscribeFocus();
    const batcher = createBlockedBatcher((names, failed) => {
      if (useUI.getState().view === FOCUS_MODULE_ID) return; // the tool shows it itself
      const st = useFocus.getState().state;
      const until = isActive(st) && st.session ? st.session.endsAt : null;
      if (names.length) toast({ tone: "neutral", title: blockedTitle(names, until, st.dryRun || !!st.session?.dryRun), duration: 4000 });
      if (failed.length) toast({ tone: "warn", title: `Couldn't stop ${failed.join(" and ")}`, duration: 6000 });
    });
    const off = on("focus:blocked", (e) => batcher.add(e));
    const stop = useFocus.subscribe((s, prev) => {
      if (s.loaded && !prev.loaded) maybeResumeToast(s.state, Date.now());
    });
    if (useFocus.getState().loaded) maybeResumeToast(useFocus.getState().state, Date.now());
    return () => {
      unsub();
      off();
      stop();
      batcher.dispose();
    };
  }, []);
}

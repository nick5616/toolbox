import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "@/components/toast";
import type { FocusBlockEvent, FocusSession, FocusState } from "@/lib/api";
import { EMPTY_FOCUS_STATE, useFocus } from "@/state/focus";
import { useUI } from "@/state/ui";
import { FocusPill } from "./FocusPill";
import {
  BLOCK_TOAST_SETTLE_MS,
  BLOCK_TOAST_THROTTLE_MS,
  blockedTitle,
  createBlockedBatcher,
  focusDuration,
  focusMinutesLeft,
  focusPillLabel,
  maybeResumeToast,
  programName,
} from "./focusShell";

function session(over: Partial<FocusSession> = {}): FocusSession {
  return {
    id: "s1", profile: { id: "p", name: "Writing", rules: [], createdAt: 0, updatedAt: 0 }, always: [], extra: [], launched: [],
    strength: "firm", onStart: "close", startedAt: 1000, endsAt: 1000 + 42 * 60_000, endedAt: 0, endReason: "", runId: "", stepId: "",
    dryRun: false, blocked: 0, ...over,
  } as FocusSession;
}

function active(over: Partial<FocusSession> = {}): FocusState {
  return { ...EMPTY_FOCUS_STATE, session: session(over) };
}

function ev(name: string, over: Partial<FocusBlockEvent> = {}): FocusBlockEvent {
  return { sessionId: "s1", at: 0, path: `C:\\Games\\${name}.exe`, name: `${name}.exe`, result: "stopped", error: "", ...over };
}

describe("focus labels", () => {
  it("rounds minutes up and formats durations", () => {
    expect(focusMinutesLeft(60_001, 0)).toBe(2);
    expect(focusMinutesLeft(5, 10)).toBe(0);
    expect(focusDuration(42)).toBe("42 min");
    expect(focusDuration(65)).toBe("1 h 5 min");
    expect(focusDuration(120)).toBe("2 h");
    expect(focusPillLabel(active(), 1000)).toBe("Focus · 42 min");
    expect(focusPillLabel(EMPTY_FOCUS_STATE, 0)).toBeNull();
    expect(focusPillLabel(active({ endedAt: 5 }), 0)).toBeNull();
  });

  it("names programs and titles toasts", () => {
    expect(programName({ name: "Steam.exe", path: "" })).toBe("Steam");
    expect(programName({ name: "", path: "/Applications/Discord.app" })).toBe("Discord.app".replace(".app", ""));
    expect(blockedTitle(["Steam"], null, false)).toBe("Stopped Steam");
    expect(blockedTitle(["A", "B", "C"], null, true)).toBe("Would stop A and 2 more");
    expect(blockedTitle(["Steam"], new Date(2026, 0, 1, 17, 30).getTime(), false)).toMatch(/^Stopped Steam · Focus until .*30/);
  });
});

describe("blocked toast batcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("batches a burst into one call and throttles per program", () => {
    let t = 0;
    const emit = vi.fn();
    const b = createBlockedBatcher(emit, () => t);
    b.add(ev("Steam"));
    b.add(ev("Discord"));
    b.add(ev("Steam")); // same program inside the throttle
    vi.advanceTimersByTime(BLOCK_TOAST_SETTLE_MS + 1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith(["Steam", "Discord"], []);

    t = BLOCK_TOAST_THROTTLE_MS - 1;
    b.add(ev("Steam"));
    vi.advanceTimersByTime(BLOCK_TOAST_SETTLE_MS + 1);
    expect(emit).toHaveBeenCalledTimes(1);

    t = BLOCK_TOAST_THROTTLE_MS;
    b.add(ev("Steam"));
    vi.advanceTimersByTime(BLOCK_TOAST_SETTLE_MS + 1);
    expect(emit).toHaveBeenCalledTimes(2);
    b.dispose();
  });

  it("ignores learn mode and unknown results, reports failures apart", () => {
    const emit = vi.fn();
    const b = createBlockedBatcher(emit, () => 0);
    b.add(ev("A", { sessionId: "" }));
    b.add(ev("B", { result: "unknown" }));
    b.add(ev("C", { result: "failed" }));
    vi.advanceTimersByTime(BLOCK_TOAST_SETTLE_MS + 1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith([], ["C"]);
  });
});

describe("resume toast", () => {
  beforeEach(() => {
    sessionStorage.clear();
    useToastStore.setState({ toasts: [] });
  });

  it("shows once for a session that began before the app started", () => {
    const st = active({ startedAt: 100, endsAt: 100 + 38 * 60_000 });
    expect(maybeResumeToast(st, 100, 500)).toBe(true);
    expect(useToastStore.getState().toasts[0]?.title).toBe("Focus resumed, 38 min left");
    expect(maybeResumeToast(st, 100, 500)).toBe(false);
  });

  it("stays quiet for sessions started in this run or no session", () => {
    expect(maybeResumeToast(active({ startedAt: 600 }), 600, 500)).toBe(false);
    expect(maybeResumeToast(EMPTY_FOCUS_STATE, 0, 500)).toBe(false);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});

describe("FocusPill", () => {
  beforeEach(() => {
    useUI.setState({ view: "library" });
    useFocus.setState({ state: EMPTY_FOCUS_STATE });
  });

  it("is hidden while idle and on the Focus tool, and opens the tool when clicked", () => {
    render(<FocusPill />);
    expect(screen.queryByTestId("focus-pill")).toBeNull();
    act(() => useFocus.setState({ state: active({ startedAt: Date.now(), endsAt: Date.now() + 42 * 60_000 - 1000 }) }));
    const pill = screen.getByTestId("focus-pill");
    expect(pill.textContent).toBe("Focus · 42 min");
    fireEvent.click(pill);
    expect(useUI.getState().view).toBe("focus");
    expect(screen.queryByTestId("focus-pill")).toBeNull();
  });
});

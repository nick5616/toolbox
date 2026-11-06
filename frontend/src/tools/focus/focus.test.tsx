import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  State: vi.fn(),
  Profiles: vi.fn(),
  Settings: vi.fn(),
  Recent: vi.fn(),
  WindowsExtras: vi.fn(),
  Blocked: vi.fn(),
  LearnList: vi.fn(),
  Apps: vi.fn(),
  AppFor: vi.fn(),
  Start: vi.fn(),
  Extend: vi.fn(),
  RequestWeaken: vi.fn(),
  ConfirmWeaken: vi.fn(),
  CancelWeaken: vi.fn(),
  SaveProfile: vi.fn(),
  SaveSettings: vi.fn(),
  SetLearn: vi.fn(),
  CloseAgain: vi.fn(),
  ForceClose: vi.fn(),
  LeaveOpen: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, FocusService: { ...svc, AppIcon: async () => "" } };
});

import { FocusStrength, FocusWeaken, type FocusProfile, type FocusSession, type FocusSettings, type FocusState } from "@/lib/api";
import { EMPTY_FOCUS_STATE, normalizeFocusState, useFocus } from "@/state/focus";
import FocusView from "./FocusView";
import { endedSummary, formatLength, learnSummary, nextClockTime, studioSuggestions, untilProblem } from "./model";

const NOW = Date.now();

function profile(id: string, name: string, n = 1): FocusProfile {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    rules: Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}`, label: `App ${i + 1}`, kind: "folder", path: `C:\\Apps\\${name}${i}`, children: true })),
  };
}

const SETTINGS: FocusSettings = {
  alwaysAllowed: [],
  defaultStrength: FocusStrength.StrengthFirm,
  onStart: "close",
  pollMs: 1000,
  learn: false,
  learnSince: 0,
  lastProfileId: "p2",
  lastMinutes: 90,
};

function session(over: Partial<FocusSession> = {}): FocusSession {
  return {
    id: "s1",
    profile: profile("p1", "Music", 2),
    always: [],
    extra: [],
    launched: [],
    strength: FocusStrength.StrengthFirm,
    onStart: "close",
    startedAt: NOW - 10 * 60_000,
    endsAt: NOW + 42 * 60_000,
    endedAt: 0,
    endReason: "",
    runId: "",
    stepId: "",
    dryRun: false,
    blocked: 0,
    ...over,
  };
}

function setState(over: Partial<FocusState>) {
  useFocus.setState({ loaded: true, blocked: [], state: normalizeFocusState({ ...EMPTY_FOCUS_STATE, ...over }) });
}

beforeEach(() => {
  svc.State.mockImplementation(async () => useFocus.getState().state);
  svc.Profiles.mockResolvedValue([profile("p1", "Music", 3), profile("p2", "Writing", 1)]);
  svc.Settings.mockResolvedValue(SETTINGS);
  svc.Recent.mockResolvedValue([]);
  svc.WindowsExtras.mockResolvedValue(["%ProgramFiles%\\Windows Defender\\"]);
  svc.Blocked.mockResolvedValue([]);
  svc.LearnList.mockResolvedValue([]);
  svc.Apps.mockResolvedValue([]);
  svc.Start.mockResolvedValue(session());
  svc.RequestWeaken.mockImplementation(async (action: FocusWeaken) => ({ action, phrase: "", readyAt: 0, rule: null }));
  svc.ConfirmWeaken.mockResolvedValue(undefined);
  svc.CancelWeaken.mockResolvedValue(undefined);
  svc.Extend.mockResolvedValue(session());
  svc.CloseAgain.mockResolvedValue(undefined);
  svc.ForceClose.mockResolvedValue(undefined);
  svc.LeaveOpen.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const props = { moduleId: "focus" } as Parameters<typeof FocusView>[0];

describe("Focus view: idle", () => {
  it("shows profile chips with the last used selected, presets and Start", async () => {
    setState({});
    render(<FocusView {...props} />);
    const chip = await screen.findByRole("radio", { name: /Writing/ });
    expect(chip.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /Music/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("radio", { name: "90 min" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Firm" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/typed phrase and a 30 second wait/)).toBeTruthy();
    expect(screen.getByTestId("focus-status").textContent).toBe("Not focusing");

    await userEvent.click(screen.getByRole("radio", { name: "Strict" }));
    await userEvent.click(screen.getByRole("radio", { name: "25 min" }));
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(svc.Start).toHaveBeenCalled());
    expect(svc.Start.mock.calls[0]![0]).toMatchObject({ profileId: "p2", minutes: 25, until: 0, strength: FocusStrength.StrengthStrict });
  });

  it("Start explains why it's disabled with no profile", async () => {
    svc.Profiles.mockResolvedValue([]);
    setState({});
    render(<FocusView {...props} />);
    const start = await screen.findByRole("button", { name: "Start" });
    expect(start.getAttribute("aria-disabled")).toBe("true");
    expect(start.getAttribute("data-tip")).toBe("Pick a profile first");
  });

  it("an invalid Until time blocks Start", async () => {
    setState({});
    render(<FocusView {...props} />);
    await userEvent.click(await screen.findByRole("radio", { name: "Until…" }));
    await userEvent.type(screen.getByLabelText("Until (24 hour time)"), "99:99");
    expect(screen.getByRole("button", { name: "Start" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("offers a Studio profile on first open", async () => {
    svc.Profiles.mockResolvedValue([]);
    const rule = (label: string) => ({ label, path: `C:\\${label}\\${label}.exe`, icon: "", store: false, rule: { id: "", label, kind: "folder", path: `C:\\${label}`, children: true } });
    svc.Apps.mockResolvedValue([rule("Discord"), rule("Steam"), rule("Visual Studio Code")]);
    svc.SaveProfile.mockImplementation(async (p: FocusProfile) => ({ ...p, id: "new" }));
    setState({});
    render(<FocusView {...props} />);
    expect(await screen.findByText(/2 apps found: Discord, Visual Studio Code/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(svc.SaveProfile).toHaveBeenCalled());
    const saved = svc.SaveProfile.mock.calls[0]![0] as FocusProfile;
    expect(saved.name).toBe("Studio");
    expect(saved.rules?.map((r) => r.label)).toEqual(["Discord", "Visual Studio Code"]);
  });

  it("unsupported systems get the message but keep the profile editor", async () => {
    setState({ supported: false, unsupported: "Linux isn't supported", os: "linux" });
    render(<FocusView {...props} />);
    expect(await screen.findByText("Focus Lock works on Windows and macOS")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(await screen.findByRole("button", { name: "New profile" })).toBeTruthy();
  });

  it("lists the Windows extras read-only", async () => {
    setState({});
    render(<FocusView {...props} />);
    expect(await screen.findByText("Windows extras (1)")).toBeTruthy();
    expect(screen.getByText("%ProgramFiles%\\Windows Defender\\")).toBeTruthy();
  });

  it("learn mode shows the summary and the would-stop list", async () => {
    svc.LearnList.mockResolvedValue([{ path: "C:\\Steam\\steam.exe", name: "Steam", count: 4, lastSeen: NOW }]);
    svc.Settings.mockResolvedValue({ ...SETTINGS, learn: true, learnSince: NOW });
    setState({ learn: true, dryRun: true });
    render(<FocusView {...props} />);
    expect(await screen.findByText("Steam")).toBeTruthy();
    expect(screen.getAllByText(/Dry run: nothing is being stopped/).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 program would have been stopped/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Always allow" })).toBeTruthy();
  });
});

describe("Focus view: active", () => {
  it("shows the countdown, end time, profile and strength; +15 extends", async () => {
    setState({ session: session() });
    render(<FocusView {...props} />);
    expect(await screen.findByText("Music")).toBeTruthy();
    expect(screen.getByText(/^until \d\d:\d\d$/)).toBeTruthy();
    expect(screen.getByText("Firm")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "+15 min" }));
    expect(svc.Extend).toHaveBeenCalledWith(15);
  });

  it("End early asks the engine for friction and the dialog confirms it", async () => {
    svc.RequestWeaken.mockResolvedValue({ action: FocusWeaken.WeakenEnd, phrase: "", readyAt: 0, rule: null });
    setState({ session: session() });
    render(<FocusView {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: "End early" }));
    expect(svc.RequestWeaken).toHaveBeenCalledWith(FocusWeaken.WeakenEnd, null);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(svc.ConfirmWeaken).toHaveBeenCalledWith(FocusWeaken.WeakenEnd, ""));
  });

  it("strict offers only Emergency unlock and no Allow", async () => {
    svc.Blocked.mockResolvedValue([{ path: "C:\\Steam\\steam.exe", name: "Steam", count: 2, last: NOW, result: "stopped", error: "" }]);
    setState({ session: session({ strength: FocusStrength.StrengthStrict }) });
    render(<FocusView {...props} />);
    expect(await screen.findByRole("button", { name: "Emergency unlock" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "End early" })).toBeNull();
    await screen.findByText("Steam");
    expect(screen.queryByRole("button", { name: "Allow for this session" })).toBeNull();
  });

  it("blocked rows can be allowed for the session, still-open rows act", async () => {
    svc.Blocked.mockResolvedValue([
      { path: "C:\\Steam\\steam.exe", name: "Steam", count: 4, last: NOW, result: "stopped", error: "" },
      { path: "C:\\Epic\\epic.exe", name: "Epic", count: 1, last: NOW, result: "failed", error: "Access denied" },
    ]);
    svc.AppFor.mockResolvedValue({ label: "Steam", path: "C:\\Steam\\steam.exe", icon: "", store: false, rule: { id: "", label: "Steam", kind: "folder", path: "C:\\Steam", children: true } });
    setState({ session: session(), stillOpen: [{ pid: 7, created: 99, name: "Chrome", path: "C:\\Chrome\\chrome.exe" }] });
    render(<FocusView {...props} />);
    expect(await screen.findByText("Stopped ×4")).toBeTruthy();
    expect(screen.getByText("Access denied")).toBeTruthy();
    await userEvent.click(screen.getAllByRole("button", { name: "Allow for this session" })[0]!);
    await waitFor(() => expect(svc.RequestWeaken).toHaveBeenCalled());
    expect(svc.RequestWeaken.mock.calls[0]![0]).toBe(FocusWeaken.WeakenAllow);
    expect(svc.RequestWeaken.mock.calls[0]![1]).toMatchObject({ path: "C:\\Steam" });

    await userEvent.click(screen.getByRole("button", { name: "Force close" }));
    expect(svc.ForceClose).toHaveBeenCalledWith(7, 99);
    await userEvent.click(screen.getByRole("button", { name: "Close again" }));
    expect(svc.CloseAgain).toHaveBeenCalledWith(7, 99);
    await userEvent.click(screen.getByRole("button", { name: "Leave it" }));
    expect(svc.LeaveOpen).toHaveBeenCalledWith(7, 99);
  });

  it("shows the dry run banner and the Mac line", async () => {
    setState({ session: session({ dryRun: true }), dryRun: true, os: "darwin" });
    render(<FocusView {...props} />);
    expect(await screen.findByText("Dry run: nothing is being stopped")).toBeTruthy();
    expect(screen.getByText(/^On the Mac:/)).toBeTruthy();
  });

  it("an engine-owned friction (e.g. quit) opens the dialog on its own", async () => {
    setState({ session: session(), friction: { action: FocusWeaken.WeakenQuit, phrase: "I'm choosing to stop early", readyAt: Date.now() + 30_000, rule: null } });
    render(<FocusView {...props} />);
    expect(await screen.findByRole("dialog", { name: /Quit Toolbox/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(svc.CancelWeaken).toHaveBeenCalled();
  });

  it("a focus:changed update flips the view", async () => {
    setState({ session: session() });
    render(<FocusView {...props} />);
    await screen.findByRole("button", { name: "End early" });
    act(() => useFocus.getState().setState({ ...EMPTY_FOCUS_STATE, session: null }));
    expect(await screen.findByRole("button", { name: "Start" })).toBeTruthy();
  });
});

describe("Focus view: ended", () => {
  it("shows a one-line summary", async () => {
    svc.Blocked.mockResolvedValue([
      { path: "a", name: "Steam", count: 4, last: NOW, result: "stopped", error: "" },
      { path: "b", name: "Epic", count: 2, last: NOW, result: "stopped", error: "" },
    ]);
    setState({ last: session({ endedAt: NOW, startedAt: NOW - 90 * 60_000, endReason: "time", blocked: 6 }) });
    render(<FocusView {...props} />);
    expect((await screen.findByTestId("focus-ended")).textContent).toBe("Focused 1 h 30 min · stopped 6 launches (Steam ×4, Epic ×2)");
  });
});

describe("model helpers", () => {
  it("formats lengths", () => {
    expect(formatLength(90 * 60_000)).toBe("1 h 30 min");
    expect(formatLength(42 * 60_000)).toBe("42 min");
    expect(formatLength(2 * 3600_000)).toBe("2 h");
  });
  it("ended summary covers none stopped and early ends", () => {
    expect(endedSummary(session({ endedAt: NOW, startedAt: NOW - 25 * 60_000, blocked: 0, endReason: "user" }), [])).toBe("Focused 25 min · nothing needed stopping · ended early");
    expect(endedSummary(session({ endedAt: NOW, startedAt: NOW - 25 * 60_000, blocked: 1, endReason: "time" }), [])).toBe("Focused 25 min · stopped 1 launch");
    expect(endedSummary(session({ endedAt: NOW, startedAt: NOW - 25 * 60_000, blocked: 2, endReason: "time", dryRun: true }), [])).toBe("Focused 25 min · would have stopped 2 launches");
  });
  it("learn summary", () => {
    expect(learnSummary(0, 0)).toBe("Watching · nothing would have been stopped yet");
    expect(learnSummary(new Date(2026, 10, 3, 9).getTime(), 14)).toBe("Watching since Tue · 14 programs would have been stopped");
  });
  it("Until time rules", () => {
    const now = new Date(2026, 10, 5, 12, 0).getTime();
    expect(nextClockTime("17:30", now)).toBe(new Date(2026, 10, 5, 17, 30).getTime());
    expect(nextClockTime("09:00", now)).toBe(new Date(2026, 10, 6, 9, 0).getTime());
    expect(nextClockTime("nope", now)).toBeNull();
    expect(untilProblem(nextClockTime("12:00", now), now)).toBe("A session can last at most 12 hours");
    expect(untilProblem(nextClockTime("12:30", now), now)).toBe("");
    expect(untilProblem(null, now)).not.toBe("");
  });
  it("Studio suggestions follow the preselected names", () => {
    const mk = (label: string) => ({ label, path: `C:\\${label}.exe`, icon: "", store: false, rule: { id: "", label, kind: "exe", path: `C:\\${label}.exe`, children: true } });
    expect(studioSuggestions([mk("Steam"), mk("Windows Terminal"), mk("Discord")]).map((a) => a.label)).toEqual(["Discord", "Windows Terminal"]);
  });
});

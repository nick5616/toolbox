import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ profiles: vi.fn() }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, FocusService: { Profiles: () => h.profiles() } };
});

// The real picker is another package's dialog; these tests only need to drive its callbacks.
vi.mock("@/blocks/app-picker", () => ({
  AppIcon: () => null,
  AppPicker: (p: {
    open: boolean;
    mode: string;
    onPickApp?: (a: { label: string; path: string }) => void;
    onPickRules?: (r: Array<{ id: string; label: string; kind: string; path: string; children: boolean }>) => void;
  }) =>
    p.open ? (
      <div role="dialog" aria-label={`picker ${p.mode}`}>
        <button onClick={() => p.onPickApp?.({ label: "Ableton Live 12", path: "C:\\Ableton\\Live.exe" })}>pick app</button>
        <button onClick={() => p.onPickRules?.([{ id: "r1", label: "Spotify", kind: "exe", path: "C:\\Spotify\\Spotify.exe", children: true }])}>pick rule</button>
      </div>
    ) : null,
}));

import { useUI } from "@/state/ui";
import { BUILTIN_VARS } from "../vars";
import { deriveParams } from "../params";
import { GO_STEP_TYPES } from "../catalogFixture";
import { DEFAULT_FOCUS_STEP, addExtraRules, focusProblem, focusSummary, parseFocusStep } from "./focus";
import { stepUI, type StepUI } from "./index";
import { DEFAULT_OPEN_STEP, openSummary, parseOpenStep } from "./open";
import { DEFAULT_WAIT_STEP, parseWaitStep, waitSummary } from "./wait";

const VARS = BUILTIN_VARS.map((v) => ({ ...v }));

function mount(type: string, json: string) {
  const ui = stepUI(type) as StepUI<unknown>;
  const last: { value: unknown } = { value: ui.parse(json) };
  function Harness(): ReactElement {
    const [value, setValue] = useState<unknown>(last.value);
    return (
      <ui.Editor
        value={value}
        vars={VARS}
        check={undefined}
        onChange={(next) => {
          last.value = next;
          setValue(next);
        }}
      />
    );
  }
  render(<Harness />);
  return last;
}

beforeEach(() => {
  h.profiles.mockReset().mockResolvedValue([
    { id: "p1", name: "Music", rules: [], createdAt: 1, updatedAt: 1 },
    { id: "p2", name: "Writing", rules: [], createdAt: 1, updatedAt: 1 },
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("parsing", () => {
  it("Wait sanitises over the defaults", () => {
    expect(parseWaitStep("{}")).toEqual(DEFAULT_WAIT_STEP);
    expect(parseWaitStep("nope")).toEqual(DEFAULT_WAIT_STEP);
    expect(parseWaitStep('{"mode":"until","at":"25:99","minutes":99999,"note":"x"}')).toEqual({ mode: "until", at: "17:00", minutes: 1440, note: "x" });
    expect(waitSummary({ ...DEFAULT_WAIT_STEP })).toBe("25 min");
    expect(waitSummary({ ...DEFAULT_WAIT_STEP, mode: "until", at: "18:15" })).toBe("until 18:15");
  });

  it("Focus sanitises over the defaults", () => {
    expect(parseFocusStep("{}")).toEqual(DEFAULT_FOCUS_STEP);
    const v = parseFocusStep('{"action":"bogus","strength":"loud","minutes":0,"ifActive":"x","extra":[1,{"id":"a","label":"A","kind":"exe","path":"C:\\\\a.exe","children":true}]}');
    expect(v).toMatchObject({ action: "start", strength: "firm", minutes: 1, ifActive: "extend" });
    expect(v.extra).toHaveLength(1);
    expect(focusSummary(DEFAULT_FOCUS_STEP)).toBe("Start focus · 50 min");
    expect(focusSummary({ ...DEFAULT_FOCUS_STEP, action: "wait" })).toBe("Wait for focus to end");
    expect(focusSummary({ ...DEFAULT_FOCUS_STEP, action: "end" })).toBe("End focus");
    expect(focusProblem(DEFAULT_FOCUS_STEP)).toBe("Pick a profile");
    expect(focusProblem({ ...DEFAULT_FOCUS_STEP, profileId: "p1" })).toBe("");
    expect(focusProblem({ ...DEFAULT_FOCUS_STEP, action: "wait" })).toBe("");
  });

  it("Open in app sanitises over the defaults", () => {
    expect(parseOpenStep("{}")).toEqual(DEFAULT_OPEN_STEP);
    const v = parseOpenStep('{"app":"C:\\\\a.exe","args":["a",1,"b"],"files":"some","window":"minimized","closeWhen":"focusEnds"}');
    expect(v).toMatchObject({ app: "C:\\a.exe", args: ["a", "b"], files: "none", window: "minimized", closeWhen: "focusEnds" });
    expect(openSummary(DEFAULT_OPEN_STEP)).toBe("Choose an app");
    expect(openSummary({ ...DEFAULT_OPEN_STEP, app: "C:\\Live\\Live.exe", label: "Ableton Live 12" })).toBe("Open Ableton Live 12");
    expect(openSummary({ ...DEFAULT_OPEN_STEP, app: "C:\\Live\\Live.exe" })).toBe("Open Live.exe");
  });

  it("extra rules are added without repeats and capped at 20", () => {
    const rule = (i: number) => ({ id: `r${i}`, label: `A${i}`, kind: "exe", path: `C:\\a${i}.exe`, children: true });
    expect(addExtraRules([rule(1)], [rule(1), rule(2)]).map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(addExtraRules(Array.from({ length: 19 }, (_, i) => rule(i)), [rule(100), rule(101)])).toHaveLength(20);
  });
});

describe("the Wait editor", () => {
  it("switches between for and until", async () => {
    const last = mount("pipelines.wait", "{}");
    expect(screen.getByLabelText("Minutes")).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: "Until" }));
    expect(last.value).toMatchObject({ mode: "until" });
    expect(screen.getByLabelText("Time")).toBeTruthy();
    expect(screen.queryByLabelText("Minutes")).toBeNull();
  });

  it("stores a note", async () => {
    const last = mount("pipelines.wait", "{}");
    await userEvent.type(screen.getByLabelText("Note (optional)"), "Stretch");
    expect(last.value).toMatchObject({ note: "Stretch" });
  });
});

describe("the Focus editor", () => {
  it("shows the start fields and lists profiles", async () => {
    const last = mount("focus", "{}");
    await waitFor(() => expect(screen.getByRole("option", { name: "Music" })).toBeTruthy());
    await userEvent.selectOptions(screen.getByLabelText("Profile"), "p2");
    expect(last.value).toMatchObject({ profileId: "p2" });
    expect(screen.getByText("Strength")).toBeTruthy();
  });

  it("asks for a profile until one is picked", () => {
    mount("focus", "{}");
    expect(screen.getAllByText("Pick a profile").length).toBeGreaterThan(0);
  });

  it("the wait and end actions have no start fields", async () => {
    const last = mount("focus", "{}");
    await userEvent.click(screen.getByRole("radio", { name: "Wait for end" }));
    expect(last.value).toMatchObject({ action: "wait" });
    expect(screen.queryByText("Strength")).toBeNull();
    expect(screen.getByText(/waits here until the focus session ends/)).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: "End" }));
    expect(last.value).toMatchObject({ action: "end" });
    expect(screen.getByText(/Ends the session this run started/)).toBeTruthy();
  });

  it("Edit profiles opens the Focus tool", async () => {
    useUI.setState({ view: "pipelines" });
    mount("focus", "{}");
    await userEvent.click(screen.getByRole("button", { name: /Edit profiles/ }));
    expect(useUI.getState().view).toBe("focus");
  });

  it("adds and removes extra allowed apps through the picker", async () => {
    const last = mount("focus", "{}");
    await userEvent.click(screen.getByRole("button", { name: "Add app…" }));
    await userEvent.click(screen.getByRole("button", { name: "pick rule" }));
    expect((last.value as { extra: unknown[] }).extra).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Remove Spotify" }));
    expect((last.value as { extra: unknown[] }).extra).toHaveLength(0);
  });
});

describe("the Open in app editor", () => {
  it("picks an app and shows it", async () => {
    const last = mount("pipelines.open", "{}");
    await userEvent.click(screen.getByRole("button", { name: /Choose app/ }));
    expect(screen.getByRole("dialog", { name: "picker app" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "pick app" }));
    expect(last.value).toMatchObject({ app: "C:\\Ableton\\Live.exe", label: "Ableton Live 12" });
    expect(screen.getByText("Ableton Live 12")).toBeTruthy();
  });

  it("adds, edits and removes arguments", async () => {
    const last = mount("pipelines.open", "{}");
    await userEvent.click(screen.getByRole("button", { name: "Add argument" }));
    expect((last.value as { args: string[] }).args).toEqual([""]);
    await userEvent.type(screen.getByLabelText("Argument 1"), "--new");
    expect((last.value as { args: string[] }).args).toEqual(["--new"]);
    await userEvent.click(screen.getByRole("button", { name: "Remove argument 1" }));
    expect((last.value as { args: string[] }).args).toEqual([]);
  });

  it("sets the files mode, window and close when", async () => {
    const last = mount("pipelines.open", "{}");
    await userEvent.selectOptions(screen.getByLabelText("Files"), "each");
    await userEvent.selectOptions(screen.getByLabelText("Window"), "minimized");
    await userEvent.selectOptions(screen.getByLabelText("Close when"), "focusEnds");
    expect(last.value).toMatchObject({ files: "each", window: "minimized", closeWhen: "focusEnds" });
  });
});

describe("parameters", () => {
  const defaults = (id: string) => GO_STEP_TYPES.find((t) => t.id === id)!.defaultsJson;
  it("Open in app never offers the program as a parameter", () => {
    const params = deriveParams(defaults("pipelines.open"), stepUI("pipelines.open")?.params);
    expect(params.map((p) => p.pointer)).not.toContain("/app");
    expect(params.map((p) => p.pointer)).toEqual(expect.arrayContaining(["/files", "/closeWhen", "/window"]));
  });

  it("Focus and Wait expose their numbers and times with deliberate labels", () => {
    const focus = deriveParams(defaults("focus"), stepUI("focus")?.params);
    expect(focus.find((p) => p.pointer === "/minutes")).toMatchObject({ label: "Minutes", type: "number" });
    expect(focus.find((p) => p.pointer === "/strength")?.type).toBe("choice");
    expect(focus.map((p) => p.pointer)).not.toContain("/action");
    const wait = deriveParams(defaults("pipelines.wait"), stepUI("pipelines.wait")?.params);
    expect(wait.map((p) => p.pointer)).toEqual(expect.arrayContaining(["/mode", "/minutes", "/at", "/note"]));
  });
});

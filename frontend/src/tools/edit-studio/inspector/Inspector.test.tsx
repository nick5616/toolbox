import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeProject } from "@/viz/edit/defaults";
import { buildEditFixture, fixtureProject } from "@/viz/edit/fixture";
import { parseEffects, parseMasks, parseSpeed, parseTransform, parseTransition, parseLook } from "@/viz/edit/schema";
import { findClip } from "../doc";
import { interpKey, useEditStudio, type Selection } from "../store";

const mocks = vi.hoisted(() => ({
  Interpolate: vi.fn(),
  InterpFor: vi.fn(),
  flush: vi.fn(async () => undefined),
}));

vi.mock("@/lib/api", async (orig) => {
  const m = await orig<typeof import("@/lib/api")>();
  return { ...m, EditStudioService: { ...m.EditStudioService, Interpolate: mocks.Interpolate, InterpFor: mocks.InterpFor } };
});
vi.mock("../useEditAutosave", () => ({ flushEdit: mocks.flush }));

import { InspectorPanel } from "./InspectorPanel";
import { useMaskSelection } from "./inspectorState";

const st = () => useEditStudio.getState();
const doc = () => st().history!.present;
const clip = (id: string) => findClip(doc(), id)!.clip;

function open(selection: Selection) {
  st().open("p1", "Test", normalizeProject(fixtureProject()));
  st().select(selection);
}

beforeEach(() => {
  mocks.Interpolate.mockReset();
  mocks.InterpFor.mockReset();
  mocks.InterpFor.mockResolvedValue(null);
  mocks.flush.mockClear();
  st().close();
  useMaskSelection.getState().select(null, null);
});

describe("Clip inspector", () => {
  it("shows the sections and edits speed, volume and fit through the store", () => {
    open({ kind: "clips", ids: ["c1"] });
    render(<InspectorPanel />);
    for (const name of ["Source", "Transform", "Effects", "Transition in", "Masks"]) expect(screen.getByRole("heading", { name })).toBeTruthy();
    fireEvent.change(screen.getByRole("slider", { name: "Speed" }), { target: { value: "1.5" } });
    expect(parseSpeed(clip("c1").speed).value).toBe(1.5);
    fireEvent.change(screen.getByRole("slider", { name: "Volume" }), { target: { value: "0.5" } });
    expect(clip("c1").volume).toBe(0.5);
    expect(screen.getByText("Heard in the export. The preview is silent.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Fit"), { target: { value: "fit-color" } });
    expect(clip("c1").fit).toBe("fit-color");
    expect(screen.getByRole("group", { name: "Fit colour" })).toBeTruthy();
  });

  it("coalesces a slider drag into one undo step and clears auto", () => {
    open({ kind: "clips", ids: ["c1"] });
    st().edit({ ...doc(), tracks: doc().tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === "c1" ? { ...c, auto: true } : c)) })) });
    render(<InspectorPanel />);
    const before = st().history!.past.length;
    const s = screen.getByRole("slider", { name: "Volume" });
    fireEvent.change(s, { target: { value: "0.3" } });
    fireEvent.change(s, { target: { value: "0.6" } });
    fireEvent.change(s, { target: { value: "0.9" } });
    expect(st().history!.past.length).toBe(before + 1);
    expect(clip("c1").volume).toBe(0.9);
    expect(clip("c1").auto).toBe(false);
  });

  it("switches speed to keyframes and warns that audio is off", async () => {
    open({ kind: "clips", ids: ["c1"] });
    render(<InspectorPanel />);
    await userEvent.click(screen.getByRole("switch", { name: "Speed changes over time" }));
    const sp = parseSpeed(clip("c1").speed).value;
    expect(typeof sp === "object" && sp.keys?.length).toBe(1);
    expect(screen.getByText("Audio is off while the speed changes.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reactions for Speed" })).toBeNull(); // keys only
    await userEvent.click(screen.getByRole("switch", { name: "Speed changes over time" }));
    expect(clip("c1").speed).toBe("");
  });

  it("makes interpolated slow motion for the clip's source span and loads the stream when done", async () => {
    open({ kind: "clips", ids: ["c1"] });
    render(<InspectorPanel />);
    fireEvent.change(screen.getByLabelText("Slow motion"), { target: { value: "interpolate" } });
    expect(clip("c1").slow).toBe("interpolate");
    expect(screen.getAllByText(/Synthesized in-between frames \(slow motion\)/).length).toBeGreaterThan(0);
    mocks.Interpolate.mockResolvedValue({ id: "job1", status: "queued", inputs: [], outputs: [] });
    await userEvent.click(screen.getByRole("button", { name: "Make" }));
    await waitFor(() => expect(mocks.Interpolate).toHaveBeenCalled());
    expect(mocks.flush).toHaveBeenCalled();
    // c1: inMs 1000, 8 s at speed 1 → 1000..9000
    expect(mocks.Interpolate).toHaveBeenCalledWith("p1", { path: "/fixture/a.mp4", fromMs: 1000, toMs: 9000, fps: 30 });
    const key = interpKey("/fixture/a.mp4", 1000, 9000);
    await waitFor(() => expect(st().jobs.interps[key]).toBe("job1"));
    expect(screen.getByText("Making slow motion…")).toBeTruthy();
  });

  it("adds a template effect, edits a param and removes it", async () => {
    open({ kind: "clips", ids: ["c2"] });
    render(<InspectorPanel />);
    expect(parseEffects(clip("c2").effects).value).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Add effect" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Blur pulse on beats" }));
    const fx = parseEffects(clip("c2").effects).value;
    expect(fx).toHaveLength(1);
    expect(fx[0]?.type).toBe("blurpulse");
    expect(screen.getByText("Blur pulse")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Remove Blur pulse" }));
    expect(clip("c2").effects).toBe("");
  });

  it("adds any offered type with its defaults and lets the enable switch toggle it", async () => {
    open({ kind: "clips", ids: ["c2"] });
    render(<InspectorPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Add effect" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Colour grade" }));
    const [fx] = parseEffects(clip("c2").effects).value;
    expect(fx?.type).toBe("grade");
    expect(fx?.params.saturation).toBe(1.1);
    await userEvent.click(screen.getByRole("switch", { name: "Enable Colour grade" }));
    expect(parseEffects(clip("c2").effects).value[0]?.enabled).toBe(false);
    // the output effects are not offered on clips
    await userEvent.click(screen.getByRole("button", { name: "Add effect" }));
    expect(screen.queryByRole("menuitem", { name: "Bloom" })).toBeNull();
  });

  it("reorders effects with the keyboard on the grip", () => {
    open({ kind: "clips", ids: ["c1"] });
    const fx = parseEffects(clip("c1").effects).value;
    const second = { id: "fx9", type: "grade" as const, enabled: true, params: {} };
    st().edit({ ...doc(), tracks: doc().tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === "c1" ? { ...c, effects: JSON.stringify([...fx, second]) } : c)) })) });
    render(<InspectorPanel />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder Zoom punch" }), { key: "ArrowDown" });
    expect(parseEffects(clip("c1").effects).value.map((p) => p.id)).toEqual(["fx9", "fx1"]);
  });

  it("sets the transition in", () => {
    open({ kind: "clips", ids: ["c3"] });
    render(<InspectorPanel />);
    expect(parseTransition(clip("c3").in).value).toEqual({ kind: "flash", ms: 300 });
    fireEvent.change(screen.getByLabelText("Transition kind"), { target: { value: "zoom" } });
    expect(parseTransition(clip("c3").in).value.kind).toBe("zoom");
    fireEvent.change(screen.getByRole("slider", { name: "Transition length" }), { target: { value: "800" } });
    expect(parseTransition(clip("c3").in).value.ms).toBe(800);
    fireEvent.change(screen.getByLabelText("Transition kind"), { target: { value: "cut" } });
    expect(clip("c3").in).toBe("");
    expect(screen.queryByRole("slider", { name: "Transition length" })).toBeNull();
  });

  it("adds masks, edits their params and shares the selection with the overlays", async () => {
    open({ kind: "clips", ids: ["c2"] });
    render(<InspectorPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Add mask" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Ellipse" }));
    const [m] = parseMasks(clip("c2").masks).value;
    expect(m?.shape).toBe("ellipse");
    expect(useMaskSelection.getState()).toMatchObject({ clipId: "c2", maskId: m?.id });
    fireEvent.change(screen.getByRole("slider", { name: "Feather" }), { target: { value: "0.2" } });
    expect(parseMasks(clip("c2").masks).value[0]?.feather).toBe(0.2);
    await userEvent.click(screen.getByRole("switch", { name: "Invert" }));
    expect(parseMasks(clip("c2").masks).value[0]?.invert).toBe(true);
    fireEvent.change(screen.getByLabelText("Mask operation"), { target: { value: "subtract" } });
    expect(parseMasks(clip("c2").masks).value[0]?.op).toBe("subtract");
    await userEvent.click(screen.getByRole("button", { name: "Remove mask 1" }));
    expect(clip("c2").masks).toBe("");
    expect(useMaskSelection.getState().maskId).toBeNull();
  });

  it("pins a clip", async () => {
    open({ kind: "clips", ids: ["c1"] });
    render(<InspectorPanel />);
    await userEvent.click(screen.getByRole("switch", { name: "Pinned" }));
    expect(clip("c1").pinned).toBe(true);
  });

  it("applies Ken Burns on the active lane's markers inside the clip", async () => {
    open({ kind: "clips", ids: ["c1"] });
    render(<InspectorPanel />);
    // No analysis in the store, so there are no markers: the entry is disabled.
    await userEvent.click(screen.getByRole("button", { name: "Clip actions" }));
    const item = await screen.findByRole("menuitem", { name: /Ken Burns/ });
    expect(item.getAttribute("aria-disabled") === "true" || (item as HTMLButtonElement).disabled).toBe(true);
  });

  it("writes Ken Burns keys at the beats inside the clip", async () => {
    open({ kind: "clips", ids: ["c1"] });
    st().setAnalysis(null, buildEditFixture(), "ready");
    st().setActiveLane("beat");
    render(<InspectorPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Clip actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Ken Burns/ }));
    const t = parseTransform(clip("c1").transform).value;
    const scale = typeof t.scale === "object" ? (t.scale.keys ?? []) : [];
    expect(scale.length).toBeGreaterThan(8);
    expect(scale.slice(0, 3).map((k) => k.v)).toEqual([1, 1.12, 1]);
    expect(Math.max(...scale.map((k) => k.t))).toBeLessThan(8000);
    expect(st().history!.past.length).toBe(1);
  });

  it("selects the cut-out and mask sections only for clips with a source", () => {
    open({ kind: "clips", ids: ["c4"] });
    render(<InspectorPanel />);
    expect(screen.getByRole("heading", { name: "Adjustment clip" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Source" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Opacity" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Masks" })).toBeTruthy();
  });
});

describe("EditParamEditor in the Inspector", () => {
  it("adds, jumps between and removes keys at the playhead's clip time", async () => {
    open({ kind: "clips", ids: ["c2"] }); // starts at 8000; scale keys at 0 and 8000
    st().setPlayhead(9000);
    render(<InspectorPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Add Scale key" }));
    expect(parseTransform(clip("c2").transform).value.scale).toMatchObject({ keys: [{ t: 0 }, { t: 1000 }, { t: 8000 }] });
    // ◀ goes to the key at 0 (clip start = playhead 8000), ▶ to the key at 8000 (playhead 16000)
    await userEvent.click(screen.getByRole("button", { name: "Previous Scale key" }));
    expect(st().playheadMs).toBe(8000);
    await userEvent.click(screen.getByRole("button", { name: "Next Scale key" }));
    expect(st().playheadMs).toBe(9000);
    await userEvent.click(screen.getByRole("button", { name: "Remove Scale key" }));
    expect(parseTransform(clip("c2").transform).value.scale).toMatchObject({ keys: [{ t: 0 }, { t: 8000 }] });
  });

  it("writes a key at the playhead when the param is keyed and the base otherwise", () => {
    open({ kind: "clips", ids: ["c2"] });
    st().setPlayhead(12_000);
    render(<InspectorPanel />);
    fireEvent.change(screen.getByRole("slider", { name: "Rotation" }), { target: { value: "10" } });
    expect(parseTransform(clip("c2").transform).value.rotation).toBe(10);
    fireEvent.change(screen.getByRole("slider", { name: "Scale" }), { target: { value: "2" } });
    const scale = parseTransform(clip("c2").transform).value.scale;
    expect(typeof scale === "object" && scale.keys?.map((k) => k.t)).toEqual([0, 4000, 8000]);
  });

  it("changes the ease of a key", async () => {
    open({ kind: "clips", ids: ["c2"] });
    st().setPlayhead(8000);
    render(<InspectorPanel />);
    fireEvent.change(screen.getByLabelText("Easing of Scale key"), { target: { value: "hold" } });
    const scale = parseTransform(clip("c2").transform).value.scale;
    expect(typeof scale === "object" && scale.keys?.[0]?.ease).toBe("hold");
  });

  it("opens the reactions editor: Markers group with lane swatches, every, sections, at most 4", async () => {
    open({ kind: "clips", ids: ["c1"] });
    render(<InspectorPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Reactions for Opacity" }));
    await userEvent.click(screen.getByRole("button", { name: "+ Add a reaction" }));
    let opacity = parseTransform(clip("c1").transform).value.opacity;
    expect(typeof opacity === "object" && opacity.mods).toHaveLength(1);
    const driver = screen.getByLabelText("Driver") as HTMLSelectElement;
    const markers = within(driver).getByRole("group", { name: "Markers" });
    expect(within(markers).getAllByRole("option")).toHaveLength(17);
    expect(within(driver).getByRole("group", { name: "Instruments" })).toBeTruthy();
    expect(screen.getByTestId("lane-swatch").getAttribute("style")).toContain("var(--lane-beat)");
    fireEvent.change(driver, { target: { value: "marker.snare" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Every" }), { target: { value: "2" } });
    fireEvent.blur(screen.getByRole("spinbutton", { name: "Every" }));
    await userEvent.click(screen.getByRole("button", { name: "chorus" }));
    opacity = parseTransform(clip("c1").transform).value.opacity;
    expect(typeof opacity === "object" && opacity.mods?.[0]).toMatchObject({ signal: "marker.snare", every: 2, sections: ["chorus"] });
    // a viz signal has no "every"
    fireEvent.change(driver, { target: { value: "kick" } });
    opacity = parseTransform(clip("c1").transform).value.opacity;
    expect(typeof opacity === "object" && opacity.mods?.[0]?.every).toBeUndefined();
    expect(screen.queryByRole("spinbutton", { name: "Every" })).toBeNull();
    expect(screen.getByRole("meter")).toBeTruthy();
    for (let i = 0; i < 4; i++) {
      const add = screen.getByRole("button", { name: "+ Add a reaction" });
      if (!(add as HTMLButtonElement).disabled) await userEvent.click(add);
    }
    opacity = parseTransform(clip("c1").transform).value.opacity;
    expect(typeof opacity === "object" && opacity.mods).toHaveLength(4);
    expect((screen.getByRole("button", { name: "+ Add a reaction" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Track, Song and Project inspectors", () => {
  it("renames, mutes and locks a track", async () => {
    open({ kind: "track", id: "t1" });
    render(<InspectorPanel />);
    fireEvent.change(screen.getByRole("textbox", { name: "Track name" }), { target: { value: "Main" } });
    expect(doc().tracks[0]?.name).toBe("Main");
    await userEvent.click(screen.getByRole("switch", { name: "Muted" }));
    await userEvent.click(screen.getByRole("switch", { name: "Locked" }));
    expect(doc().tracks[0]).toMatchObject({ muted: true, locked: true });
  });

  it("edits the song: range display, gain, fades and cut offset text", async () => {
    open({ kind: "song" });
    render(<InspectorPanel />);
    expect(screen.getAllByText("0:24.0")).toHaveLength(2); // the range end and the edit length
    fireEvent.change(screen.getByRole("slider", { name: "Song gain" }), { target: { value: "-6" } });
    expect(doc().song?.gainDb).toBe(-6);
    fireEvent.change(screen.getByRole("slider", { name: "Fade in" }), { target: { value: "1500" } });
    expect(doc().song?.fadeInMs).toBe(1500);
    fireEvent.change(screen.getByRole("slider", { name: "Cut offset" }), { target: { value: "-2" } });
    expect(doc().cutOffsetFrames).toBe(-2);
    expect(screen.getByText("Cuts land 2 frames early.")).toBeTruthy();
    fireEvent.change(screen.getByRole("slider", { name: "Cut offset" }), { target: { value: "1" } });
    expect(screen.getByText("Cuts land 1 frame late.")).toBeTruthy();
    // "Change range…" is wired by the integrator; here it keeps the Song inspector
    await userEvent.click(screen.getByRole("button", { name: "Change range…" }));
    expect(st().selection).toEqual({ kind: "song" });
  });

  it("shows the project settings when nothing is selected", async () => {
    open(null);
    render(<InspectorPanel />);
    fireEvent.change(screen.getByLabelText("Aspect"), { target: { value: "4:5" } });
    expect(doc().aspect).toBe("4:5");
    expect(doc().tracks[0]?.clips.length).toBeGreaterThan(0); // clips kept
    fireEvent.change(screen.getByLabelText("Frame rate"), { target: { value: "60" } });
    expect(doc().fps).toBe(60);
    expect(screen.getByText("Changing the frame rate prepares every source video again.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Export size"), { target: { value: "1440" } });
    expect(doc().exportHeight).toBe(1440);
    const seed = doc().seed;
    await userEvent.click(screen.getByRole("button", { name: "New seed" }));
    expect(doc().seed).not.toBe(seed);
  });

  it("applies a Look preset into the Look stack and switches to Custom when its grade is edited", async () => {
    open(null);
    render(<InspectorPanel />);
    fireEvent.change(screen.getByLabelText("Look preset"), { target: { value: "noir" } });
    const look = parseLook(doc().look).value;
    expect(look[0]).toMatchObject({ type: "grade", params: { saturation: 0, gamma: 1.2, gain: 1.15 } });
    // the Look stack also offers the output effects
    await userEvent.click(screen.getByRole("button", { name: "Add effect" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Bloom" }));
    expect(parseLook(doc().look).value.map((p) => p.type)).toEqual(["grade", "bloom"]);
    fireEvent.change(screen.getByLabelText("Look preset"), { target: { value: "none" } });
    expect(parseLook(doc().look).value.map((p) => p.type)).toEqual(["bloom"]);
  });
});

describe("Multiple clips", () => {
  it("pins all of them", async () => {
    open({ kind: "clips", ids: ["c1", "c2"] });
    render(<InspectorPanel />);
    expect(screen.getByRole("heading", { name: "2 clips selected" })).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: "Pinned" }));
    expect(clip("c1").pinned && clip("c2").pinned).toBe(true);
  });
});

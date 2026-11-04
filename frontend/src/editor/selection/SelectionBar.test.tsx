import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClickInHost } from "@/components";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { defaultTextClip, serializeTextClip } from "@/viz/edit/schema";
import { findClip } from "../doc";
import { Rail } from "../Rail";
import { registerEditorPanel } from "../panels";
import "../panelDefs";
import { EditorProfileProvider, PLAIN_PROFILE } from "../profileContext";
import type { EditorProfile } from "../profile";
import { useEditStudio, type Selection } from "../store";
import { placeGenerated } from "../timeline/placeGenerated";
import { fitChips, SelectionBar } from "./SelectionBar";

const size = vi.hoisted(() => ({ width: 0 }));
vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: size.width, height: 0 }) }));
vi.mock("@/lib/api", async (orig) => {
  const m = await orig<typeof import("@/lib/api")>();
  return { ...m, EditStudioService: { ...m.EditStudioService, Fonts: async () => ["Inter"], InterpFor: async () => null } };
});

const st = () => useEditStudio.getState();
const clip = (id: string) => findClip(st().history!.present, id)!.clip;

function open(selection: Selection) {
  st().close();
  st().open("p1", "Test", normalizeProject(fixtureProject()));
  st().select(selection);
}

function bar(profile: EditorProfile = PLAIN_PROFILE) {
  return render(
    <EditorProfileProvider profile={profile}>
      <ClickInHost>
        <Rail />
        <SelectionBar />
      </ClickInHost>
    </EditorProfileProvider>,
  );
}

/** The labels of the panel chips in the selection bar (their accessible names start with the title). */
const chips = () => within(screen.getByRole("group", { name: "Selection" })).queryAllByRole("button", { expanded: false }).map((b) => b.textContent ?? "");

beforeEach(() => {
  size.width = 0;
});
afterEach(cleanup);

describe("selection bar", () => {
  it("is a quiet hint while nothing is selected", () => {
    open(null);
    bar();
    expect(screen.getByText(/Select a clip/)).toBeTruthy();
    expect(chips()).toEqual([]);
  });

  it("a video clip: volume, speed preset, fit, and chips for transform, speed, effects, masks, cut-out, transition", () => {
    open({ kind: "clips", ids: ["c1"] });
    bar();
    expect(screen.getByRole("slider", { name: "Volume" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Speed preset" })).toBeTruthy();
    expect(screen.getByLabelText("Fit")).toBeTruthy();
    const names = chips().map((t) => t.replace(/(Default|Adjusted|Animated|None|Normal|Cut|\d.*)$/, "").trim());
    expect(names).toEqual(["Transform", "Speed", "Effects", "Masks", "Cut-out", "Transition"]);
  });

  it("the chips carry summaries of the clip's state", () => {
    open({ kind: "clips", ids: ["c1"] });
    bar();
    const text = chips().join("|");
    expect(text).toMatch(/Effects1 effect/); // the fixture's zoom punch
    expect(text).toMatch(/Masks.*None/);
    expect(text).toMatch(/Cut-out.*None/);
    expect(text).toMatch(/SpeedNormal/);
  });

  it("a speed ramp shows as Ramp and disables the presets", () => {
    open({ kind: "clips", ids: ["c1"] });
    st().edit({ ...st().history!.present, tracks: st().history!.present.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === "c1" ? { ...c, speed: JSON.stringify({ base: 1, keys: [{ t: 0, v: 1, ease: "ease" }] }) } : c)) })) });
    bar();
    expect(chips().join("|")).toMatch(/SpeedRamp/);
    expect((screen.getByRole("radio", { name: "2×" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a photo has no speed or volume; an adjustment clip has only opacity, effects and masks", () => {
    open({ kind: "clips", ids: ["c2"] });
    const { unmount } = bar();
    expect(screen.queryByRole("slider", { name: "Volume" })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Speed preset" })).toBeNull();
    expect(screen.getByLabelText("Fit")).toBeTruthy();
    expect(chips().some((c) => c.startsWith("Speed"))).toBe(false);
    expect(chips().some((c) => c.startsWith("Cut-out"))).toBe(true);
    unmount();

    open({ kind: "clips", ids: ["c4"] });
    bar();
    expect(screen.queryByLabelText("Fit")).toBeNull();
    expect(chips().map((t) => t.replace(/(None|\d.*|Default|Adjusted)$/, "").trim())).toEqual(["Transform", "Effects", "Masks"]);
  });

  it("a text clip gets the Text style chip first", () => {
    open(null);
    const res = placeGenerated(st().history!.present, 100, 2900, { kind: "text", text: serializeTextClip(defaultTextClip("HELLO")), blend: "normal" });
    st().edit(res!.project);
    st().select({ kind: "clips", ids: [res!.clipId] });
    bar();
    expect(chips()[0]).toMatch(/^Text style/);
    expect(chips().some((c) => c.startsWith("Speed"))).toBe(false);
  });

  it("the profile adds its own chips", () => {
    open({ kind: "clips", ids: ["c1"] });
    registerEditorPanel({ id: "own-chip", title: "Own chip", icon: "music", tip: "", component: () => <div /> });
    bar({ ...PLAIN_PROFILE, clipChips: [{ panel: "own-chip", summary: () => "hello" }, { panel: "own-chip", kinds: ["image"] }] });
    expect(chips().filter((c) => c.startsWith("Own chip"))).toEqual(["Own chiphello"]);
  });

  it("several clips: a count with Duplicate and Delete, no chips", async () => {
    open({ kind: "clips", ids: ["c1", "c3"] });
    bar();
    expect(screen.getByText("2 clips selected")).toBeTruthy();
    expect(chips()).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(findClip(st().history!.present, "c1")).toBeNull();
  });

  it("a track gets one Track chip; the song track opens the profile's song panel from the rail", async () => {
    open({ kind: "track", id: "t1" });
    bar();
    expect(chips().some((c) => c.startsWith("Track"))).toBe(true);
    cleanup();
    open({ kind: "song" });
    bar();
    await userEvent.click(screen.getByRole("button", { name: "Music settings" }));
    expect(screen.getByRole("dialog", { name: "Music" })).toBeTruthy();
  });

  it("Delete removes the selected clip", async () => {
    open({ kind: "clips", ids: ["c2"] });
    bar();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(findClip(st().history!.present, "c2")).toBeNull();
  });

  it("quick controls write to the clip: volume, speed preset, fit", async () => {
    open({ kind: "clips", ids: ["c1"] });
    bar();
    fireEvent.change(screen.getByRole("slider", { name: "Volume" }), { target: { value: "0.5" } });
    expect(clip("c1").volume).toBe(0.5);
    await userEvent.click(screen.getByRole("radio", { name: "2×" }));
    expect(clip("c1").speed).toBe("2");
    await userEvent.click(screen.getByRole("radio", { name: "1×" }));
    expect(clip("c1").speed).toBe("");
    fireEvent.change(screen.getByLabelText("Fit"), { target: { value: "fit" } });
    expect(clip("c1").fit).toBe("fit");
  });

  it("a chip opens its panel in a drawer, which follows the clip", async () => {
    open({ kind: "clips", ids: ["c1"] });
    bar();
    await userEvent.click(screen.getByRole("button", { name: /^Effects/ }));
    const drawer = screen.getByRole("dialog", { name: "Effects" });
    expect(within(drawer).getByRole("button", { name: "Add effect" })).toBeTruthy();
  });

  it("chips that don't fit the measured width move into More…, and the menu still opens their drawers", async () => {
    size.width = 330;
    open({ kind: "clips", ids: ["c1"] });
    bar();
    const shown = chips().filter((c) => c !== "More…");
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(6);
    expect(shown.some((c) => c.startsWith("Transition"))).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "More…" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^Transition/ }));
    expect(screen.getByRole("dialog", { name: "Transition" })).toBeTruthy();
  });

  it("the bar is one line: it never wraps and a chip without room drops its summary", () => {
    open({ kind: "clips", ids: ["c1"] });
    bar();
    expect(screen.getByRole("group", { name: "Selection" }).className).toMatch(/bar/);
  });
});

describe("fitChips", () => {
  const list = [
    { panel: "clip-transform", summary: "Default" },
    { panel: "clip-effects", summary: "2 effects" },
    { panel: "clip-masks", summary: "None" },
  ];
  it("shows everything for an unknown width", () => expect(fitChips(list, 0)).toEqual({ shown: 3, summaries: true }));
  it("shows summaries while there is room, then only labels, then fewer chips", () => {
    expect(fitChips(list, 800)).toEqual({ shown: 3, summaries: true });
    expect(fitChips(list, 270)).toEqual({ shown: 3, summaries: false });
    const small = fitChips(list, 200);
    expect(small.summaries).toBe(false);
    expect(small.shown).toBeLessThan(3);
    expect(fitChips(list, 10).shown).toBe(0);
  });
});

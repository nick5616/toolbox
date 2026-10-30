import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    VisualizerService: { Fonts: async () => ["Arial", "Georgia"], Enqueue: async () => [] },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    MediaService: { Open: async () => ({}), Frame: async () => "", Waveform: async () => [], URLFor: async () => "" },
  };
});

vi.mock("@/components/media", async (orig) => {
  const actual = await orig<typeof import("@/components/media")>();
  const React = await import("react");
  return {
    ...actual,
    useMediaSource: () => ({ status: "ready", source: { url: "/media/t/song.mp3", proxy: false, proxyJobId: "", info: { durationMs: 60000, tags: {} } }, retry() {} }),
    MediaPlayer: React.forwardRef(function Stub(_p: unknown, ref: React.Ref<unknown>) {
      React.useImperativeHandle(ref, () => ({ play() {}, pause() {}, toggle() {}, seek() {}, step() {}, currentMs: () => 0, playing: () => false }));
      return <div data-testid="own-player" />;
    }),
  };
});

vi.mock("@/components/viz", () => ({
  VisualsCanvas: () => <div data-testid="canvas" />,
  PresetThumbs: (p: { items: Array<{ id: string; name: string }>; onSelect(i: unknown): void }) => (
    <div>
      {p.items.map((i) => (
        <button key={i.id} onClick={() => p.onSelect(i)}>
          {`card ${i.name}`}
        </button>
      ))}
    </div>
  ),
  useVisualsAnalysis: () => ({ status: "idle", progress: 0, stage: "", ref: null, analysis: null, error: null, start() {}, cancel() {} }),
  VisualsPicker: () => null,
}));

vi.mock("./SongMap", () => ({ SongMap: () => <div data-testid="songmap" /> }));

import type { ReactNode } from "react";
import { buildFixture } from "@/viz/fixture";
import { PRESETS, presetById, showFromPreset } from "@/viz/presets";
import type { Show } from "@/viz/types";
import { validateShow } from "@/viz/validate";
import { VisualDesigner } from "./designer/VisualDesigner";
import { deleteLayer, moveLayer, removeReaction, setReactionAmount } from "./designer/model";
import { useShowHistory, useUndoKeys, type ShowHistory } from "./designer/useShowHistory";
import { whyFacts } from "./designer/why";
import { Signals } from "@/viz/signals";
import { seededShow } from "./useSeed";
import { useVisualizer } from "./store";

const analysis = buildFixture({ durationMs: 30_000 });
const base = (): Show => showFromPreset(PRESETS[0]!);
const latest: { current: ShowHistory | null } = { current: null };

function Harness({ initial = base(), text = "engine" as "engine" | { overlay: (r: unknown, t: number) => ReactNode }, tabs }: { initial?: Show; text?: "engine" | { overlay: (r: unknown, t: number) => ReactNode }; tabs?: Array<"presets" | "look" | "reactions" | "layers" | "timeline"> }) {
  const history = useShowHistory(initial, { coalesceMs: 0 });
  useUndoKeys(history);
  latest.current = history;
  return <VisualDesigner inputPath="song.mp3" analysis={analysis} show={history.show} onChange={history.set} aspect={16 / 9} mode="full" player={null} text={text as never} tabs={tabs} />;
}

const show = () => latest.current!.show;
const sceneLayers = (id = "calm") => show().scenes.find((s) => s.id === id)!.layers;

beforeEach(() => {
  latest.current = null;
  useVisualizer.getState().reset();
});

async function openTab(name: string) {
  await userEvent.click(screen.getByRole("tab", { name: new RegExp(name) }));
}

describe("show editing model", () => {
  it("is pure: edits return new shows", () => {
    const s = base();
    const frozen = JSON.stringify(s);
    moveLayer(s, "calm", 0, 1);
    deleteLayer(s, "calm", "bars");
    setReactionAmount(s, 0, 1);
    removeReaction(s, 0);
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

describe("Reactions tab", () => {
  it("changes the driver and amount on every scene, adds and removes rows", async () => {
    render(<Harness />);
    await openTab("Reactions");
    const rows = screen.getByRole("list", { name: "Reactions" });
    expect(within(rows).getAllByRole("listitem")).toHaveLength(4);

    await userEvent.selectOptions(screen.getByLabelText("Bar height driver"), "snare");
    for (const sc of show().scenes) {
      const h = sc.layers.find((l) => l.id === "bars")!.params.height as { mods: Array<{ signal: string }> };
      expect(h.mods[0]!.signal).toBe("snare");
    }

    fireEvent.change(screen.getByLabelText("Bar height amount"), { target: { value: "1.5" } });
    const h = sceneLayers("main").find((l) => l.id === "bars")!.params.height as { mods: Array<{ amount: number }> };
    expect(h.mods[0]!.amount).toBeCloseTo(1.5);

    // add: Gradient (bg) → Speed
    await userEvent.selectOptions(screen.getByLabelText("Layer"), "bg");
    await userEvent.selectOptions(screen.getByLabelText("Parameter"), "bg.speed");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(show().controls).toHaveLength(5);
    const speed = sceneLayers().find((l) => l.id === "bg")!.params.speed as { mods: unknown[] };
    expect(speed.mods.length).toBe(1);
    expect(validateShow(show()).ok).toBe(true);

    // remove: the row goes and the parameter stops reacting
    await userEvent.click(screen.getByRole("button", { name: "Remove Bar height" }));
    expect(show().controls.map((c) => c.label)).not.toContain("Bar height");
    expect(typeof sceneLayers().find((l) => l.id === "bars")!.params.height).toBe("number");
  });
});

describe("Layers tab", () => {
  it("reorders and deletes layers, and adds from the catalogue", async () => {
    render(<Harness />);
    await openTab("Layers");
    expect(sceneLayers().map((l) => l.id)).toEqual(["bg", "bars"]);

    await userEvent.click(screen.getByRole("button", { name: "Move bars down" }));
    expect(sceneLayers().map((l) => l.id)).toEqual(["bars", "bg"]);
    await userEvent.click(screen.getByRole("button", { name: "Move bars up" }));
    expect(sceneLayers().map((l) => l.id)).toEqual(["bg", "bars"]);
    // other scenes are untouched
    expect(sceneLayers("main").map((l) => l.id)).toEqual(["bg", "bars"]);

    await userEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Layer catalogue" })).getAllByRole("button")[0]!);
    expect(sceneLayers()).toHaveLength(3);

    await userEvent.click(screen.getByRole("button", { name: "Delete bars" }));
    expect(sceneLayers().map((l) => l.id)).not.toContain("bars");
    // the other scenes still have it, so its Reactions rows stay
    expect(show().controls.some((c) => c.target.startsWith("bars."))).toBe(true);
  });

  it("edits a parameter's reactions (mods editor)", async () => {
    render(<Harness />);
    await openTab("Layers");
    await userEvent.click(screen.getByRole("button", { name: /^Spectrum bars/ }));
    const group = screen.getByRole("group", { name: "Spectrum bars settings" });
    await userEvent.click(within(group).getByRole("button", { name: "Reactions for Glow" }));
    const mods = within(group).getByRole("group", { name: "Reactions of Glow" });
    await userEvent.click(within(mods).getByRole("button", { name: "+ Add a driver" }));
    const glow = () => sceneLayers().find((l) => l.id === "bars")!.params.glow as { base: number; mods: Array<{ signal: string; amount: number; shape: string }> };
    expect(glow().mods).toHaveLength(1);
    await userEvent.selectOptions(within(mods).getByLabelText("Driver"), "kick");
    await userEvent.selectOptions(within(mods).getByLabelText("Shape"), "gate");
    fireEvent.change(within(mods).getByLabelText("Amount"), { target: { value: "-0.5" } });
    expect(glow().mods[0]).toMatchObject({ signal: "kick", shape: "gate", amount: -0.5 });
    await userEvent.click(within(mods).getByRole("button", { name: "Remove reaction" }));
    expect(typeof sceneLayers().find((l) => l.id === "bars")!.params.glow).toBe("number");
  });
});

describe("Undo and redo", () => {
  it("steps through edits with Ctrl+Z and Ctrl+Shift+Z", async () => {
    render(<Harness />);
    await openTab("Layers");
    const before = show();
    await userEvent.click(screen.getByRole("button", { name: /^Hide Spectrum bars/ }));
    expect(sceneLayers().find((l) => l.id === "bars")!.enabled).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Delete bg" }));
    expect(latest.current!.canUndo).toBe(true);

    await userEvent.keyboard("{Control>}z{/Control}");
    expect(sceneLayers().map((l) => l.id)).toEqual(["bg", "bars"]);
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(show()).toBe(before);
    expect(latest.current!.canUndo).toBe(false);

    await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    expect(sceneLayers().find((l) => l.id === "bars")!.enabled).toBe(false);
    expect(latest.current!.canRedo).toBe(true);
  });

  it("keeps at most 100 steps", () => {
    function H100() {
      const h = useShowHistory(base(), { coalesceMs: 0 });
      latest.current = h;
      return null;
    }
    render(<H100 />);
    for (let i = 0; i < 120; i++) act(() => latest.current!.set({ ...latest.current!.show, speed: 0.25 + (i % 7) * 0.1 }));
    let n = 0;
    while (latest.current!.canUndo) {
      act(() => latest.current!.undo());
      n++;
    }
    expect(n).toBe(100);
  });
});

describe("Text in the designer", () => {
  it("shows the text section with engine text", async () => {
    render(<Harness />);
    await openTab("Look");
    expect(await screen.findByText("Words on screen")).toBeTruthy();
  });

  it("hides the text section and never emits text when the host draws the words", async () => {
    const withText = base();
    withText.text = {
      preset: "karaoke", font: "Arial", weight: 700, size: 6, color: "#ffffff", highlight: "mood", position: "lower", showNext: true, uppercase: false,
      outline: 0.05, glow: 0.3, emphasis: { scale: 1.25, glow: 0.6, color: "highlight", sparks: true }, react: { signal: null, amount: 1 }, titleCard: null,
    };
    render(<Harness initial={withText} text={{ overlay: () => <div data-testid="host-text">words</div> }} />);
    await openTab("Look");
    expect(screen.queryByText("Words on screen")).toBeNull();
    fireEvent.change(screen.getByLabelText("Reactivity"), { target: { value: "1.5" } });
    expect(show().reactivity).toBeCloseTo(1.5);
    expect(show().text).toBeNull();
    await openTab("Presets");
    await userEvent.click(screen.getByRole("button", { name: /^card / }));
    expect(show().text).toBeNull();
  });

  it("honours the tabs prop", () => {
    render(<Harness tabs={["look", "layers"]} />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Look", "Layers"]);
  });
});

describe("Look tab", () => {
  it("edits the palette, sliders and mix", async () => {
    render(<Harness />);
    await openTab("Look");
    await userEvent.click(screen.getByRole("button", { name: "Fire" }));
    expect(show().palette.ids).toEqual(["fire"]);
    await userEvent.click(screen.getByRole("radio", { name: "Journey" }));
    expect(show().palette.mode).toBe("journey");
    expect(show().palette.ids.length).toBeGreaterThanOrEqual(2);
    fireEvent.change(screen.getByLabelText("Drums"), { target: { value: "1.5" } });
    expect(show().mix.drums).toBeCloseTo(1.5);
    fireEvent.change(screen.getByLabelText("Intensity"), { target: { value: "1.4" } });
    expect(show().post.find((p) => p.type === "grade")).toBeTruthy();
    expect(validateShow(show()).ok).toBe(true);
  });
});

describe("Timeline tab", () => {
  it("switches to manual with one entry per section and resets to auto", async () => {
    render(<Harness />);
    await openTab("Timeline");
    await userEvent.click(screen.getByRole("radio", { name: "Manual" }));
    expect(show().timeline.mode).toBe("manual");
    expect(show().timeline.entries).toHaveLength(analysis.audio.sections.length);
    await userEvent.click(within(screen.getByRole("list", { name: "Sections" })).getAllByRole("button")[1]!);
    await userEvent.selectOptions(screen.getByLabelText("Scene"), "full");
    expect(show().timeline.entries[1]!.sceneId).toBe("full");
    await userEvent.selectOptions(screen.getByLabelText("Palette"), "fire");
    expect(show().timeline.entries[1]!.paletteId).toBe("fire");
    expect(validateShow(show()).ok).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Reset to auto" }));
    expect(show().timeline).toEqual({ mode: "auto", entries: [] });
  });
});

describe("Why", () => {
  it("lists the section, the strongest reactions and the palette", () => {
    const facts = whyFacts(base(), analysis, new Signals(analysis), 20_000);
    expect(facts.length).toBeGreaterThan(1);
    expect(facts.length).toBeLessThanOrEqual(4);
    expect(facts[0]).toMatch(/energy \d\.\d\d/);
    expect(facts.at(-1)).toMatch(/^Colours:/);
  });
});

describe("Timed-text seed", () => {
  it("starts from the tool's preset (or the first one) with its look as the text style", () => {
    const look = { font: "Georgia", textColor: "#eeeeee", highlightColor: "#ff00aa", karaoke: true, position: "center" as const };
    const lv = seededShow({ from: "lyric-video", look, overlay: false }, "full")!;
    expect(lv.presetId).toBe(presetById("lyric-stage") ? "lyric-stage" : PRESETS[0]!.id);
    expect(lv.text).toMatchObject({ font: "Georgia", color: "#eeeeee", highlight: "#ff00aa", preset: "karaoke", position: "center" });
    expect(validateShow(lv).ok).toBe(true);

    const sub = seededShow({ from: "subtitles", look: { ...look, karaoke: false, position: "lower" }, overlay: true }, "overlay")!;
    expect(sub.presetId).toBe(presetById("clean-captions") ? "clean-captions" : PRESETS[0]!.id);
    expect(sub.text).toMatchObject({ preset: "subtitle", position: "lower" });
  });
});

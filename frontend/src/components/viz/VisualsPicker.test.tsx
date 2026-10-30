import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  analysisFor: vi.fn(),
  enqueue: vi.fn(),
  moodReady: { value: false },
  moduleState: { value: "" },
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    VisualizerService: {
      AnalysisFor: (...a: unknown[]) => h.analysisFor(...a),
      Defaults: async () => ({ action: "", analyze: {} }),
      Enqueue: (...a: unknown[]) => h.enqueue(...a),
      MoodReaderReady: async () => h.moodReady.value,
    },
    MediaService: { URLFor: async (p: string) => `/media/t/${p}` },
    JobsService: { Cancel: async () => undefined },
    SettingsService: { ModuleState: async () => h.moduleState.value, SetModuleState: async () => undefined },
  };
});

vi.mock("@/viz/analysis", async (orig) => {
  const actual = await orig<typeof import("@/viz/analysis")>();
  // Imported at call time: fixture.ts imports analysis.ts, which is being mocked right here.
  return { ...actual, loadAnalysis: async () => (await import("@/viz/fixture")).buildFixture({ durationMs: 10_000, fps: 30 }) };
});

vi.mock("@/viz/engine", () => ({
  Engine: class {
    options = { width: 320, height: 180 };
    constructor(
      readonly canvas: HTMLCanvasElement,
      opts: { width: number; height: number },
    ) {
      this.options = { width: opts.width, height: opts.height };
    }
    setAnalysis() {}
    setShow() {}
    setTextures() {}
    setQuality() {}
    resize() {}
    render() {}
    dispose() {}
  },
}));

import { JobStatus, type TimedLine, type VisualsSpec } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { PRESETS, showFromPreset } from "@/viz/presets";
import { VisualsPicker } from "./VisualsPicker";

const preset = PRESETS[0]!;
const REF = {
  key: "k",
  audioJson: "a.json",
  featuresPath: "f.bin",
  textJson: "",
  instrumental: "",
  summary: { durationMs: 1000, tempo: 120, key: "C", sections: [], hasStems: false, hasWords: false, hasMeaning: false, moodSource: "", language: "", lines: 0, warnings: [] },
};

function Harness({ initial, onChange, onOpenDesigner, lines }: { initial: VisualsSpec | null; onChange: (v: VisualsSpec) => void; onOpenDesigner?: () => void; lines?: TimedLine[] | null }) {
  const [value, setValue] = useState<VisualsSpec | null>(initial);
  return (
    <VisualsPicker
      inputPath="/song.mp3"
      lines={lines ?? null}
      value={value}
      mode="background"
      aspect={16 / 9}
      onOpenDesigner={onOpenDesigner}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

const selected: VisualsSpec = { showJson: JSON.stringify(showFromPreset(preset)), stems: false, useWords: true };

beforeEach(() => {
  vi.clearAllMocks();
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  useJobs.setState({ byId: {} });
  h.moodReady.value = false;
  h.moduleState.value = "";
  h.analysisFor.mockResolvedValue([REF, true]);
});

describe("VisualsPicker", () => {
  it("does not start an analysis when AnalysisFor hits", async () => {
    render(<Harness initial={null} onChange={() => undefined} />);
    await waitFor(() => expect(h.analysisFor).toHaveBeenCalled());
    await screen.findByRole("button", { name: preset.name });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(screen.queryByText(/Listening to the song/)).toBeNull();
  });

  it("starts an analysis on a miss and shows its progress", async () => {
    h.analysisFor.mockResolvedValue([REF, false]);
    h.enqueue.mockResolvedValue([{ id: "j1" }]);
    render(<Harness initial={null} onChange={() => undefined} />);
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
    act(() => useJobs.getState().upsert({ id: "j1", moduleId: "visualizer", status: JobStatus.JobRunning, progress: 0.4, message: "Finding the beat", inputs: [], outputs: [] } as never));
    expect(await screen.findByText(/Listening to the song… 40%/)).toBeTruthy();
    expect(screen.getByText("Finding the beat")).toBeTruthy();
  });

  it("asks for words from the lines and stems off by default", async () => {
    h.analysisFor.mockResolvedValue([REF, false]);
    h.enqueue.mockResolvedValue([{ id: "j1" }]);
    h.moodReady.value = true;
    const lines = [{ startMs: 0, endMs: 1000, text: "hello", words: null }] as unknown as TimedLine[];
    render(<Harness initial={null} onChange={() => undefined} lines={lines} />);
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
    const analyze = (h.enqueue.mock.calls[0]?.[1] as { analyze: { stems: boolean; words: string; mood: boolean } }).analyze;
    expect(analyze.stems).toBe(false);
    expect(analyze.words).toBe("given");
    expect(analyze.mood).toBe(true);
  });

  it("selecting a card calls onChange with that preset's show", async () => {
    const onChange = vi.fn();
    render(<Harness initial={null} onChange={onChange} />);
    await userEvent.click(await screen.findByRole("button", { name: preset.name }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const spec = onChange.mock.calls[0]?.[0] as VisualsSpec;
    expect(JSON.parse(spec.showJson)).toEqual(showFromPreset(preset));
    expect(spec.stems).toBe(false);
    expect(spec.useWords).toBe(true);
  });

  it("Intensity edits the show's reactivity", async () => {
    const onChange = vi.fn();
    render(<Harness initial={selected} onChange={onChange} />);
    const slider = await screen.findByLabelText("Intensity");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(slider, { target: { value: "1.5" } });
    const spec = onChange.mock.calls.at(-1)?.[0] as VisualsSpec;
    expect(JSON.parse(spec.showJson).reactivity).toBe(1.5);
  });

  it("Colours sets a fixed palette and Design's own restores the design's palette", async () => {
    const onChange = vi.fn();
    render(<Harness initial={selected} onChange={onChange} />);
    await userEvent.click(await screen.findByRole("button", { name: "Fire" }));
    let show = JSON.parse((onChange.mock.calls.at(-1)?.[0] as VisualsSpec).showJson);
    expect(show.palette).toEqual({ mode: "fixed", ids: ["fire"] });
    await userEvent.click(screen.getByRole("button", { name: "Design's own" }));
    show = JSON.parse((onChange.mock.calls.at(-1)?.[0] as VisualsSpec).showJson);
    expect(show.palette).toEqual(showFromPreset(preset).palette);
  });

  it("shows a custom design as its own card", async () => {
    const custom = { ...showFromPreset(preset), presetId: null, name: "Mine now" };
    render(<Harness initial={{ ...selected, showJson: JSON.stringify(custom) }} onChange={() => undefined} />);
    expect(await screen.findByRole("button", { name: "Custom design" })).toBeTruthy();
  });

  it("lists saved designs first, read from the Visualizer's state", async () => {
    h.moduleState.value = JSON.stringify({ myPresets: [{ id: "x1", name: "Neon night", show: showFromPreset(preset) }] });
    render(<Harness initial={null} onChange={() => undefined} />);
    const mine = await screen.findByRole("button", { name: "Neon night" });
    const cards = screen.getAllByRole("button", { pressed: false }).filter((b) => b.getAttribute("aria-pressed") !== null);
    expect(cards[0]).toBe(mine);
  });

  it("Open the full designer calls back", async () => {
    const onOpen = vi.fn();
    render(<Harness initial={selected} onChange={() => undefined} onOpenDesigner={onOpen} />);
    await userEvent.click(screen.getByRole("button", { name: "Open the full designer" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("the words switch only shows when there are lines", async () => {
    const { rerender } = render(<VisualsPicker inputPath="/s.mp3" lines={null} value={null} onChange={() => undefined} mode="background" aspect={1.5} />);
    expect(screen.queryByRole("switch", { name: "React to the words" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Separate instruments" })).toBeTruthy();
    rerender(<VisualsPicker inputPath="/s.mp3" lines={[{ startMs: 0, endMs: 1, text: "x", words: null }] as unknown as TimedLine[]} value={null} onChange={() => undefined} mode="background" aspect={1.5} />);
    expect(screen.getByRole("switch", { name: "React to the words" })).toBeTruthy();
  });
});

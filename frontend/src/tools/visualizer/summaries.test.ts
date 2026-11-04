import { describe, expect, it } from "vitest";
import { WordsSource } from "@/lib/api";
import { buildFixture } from "@/viz/fixture";
import { presetById, showFromPreset } from "@/viz/presets";
import { DEFAULT_ANALYZE } from "./store";
import { layersSummary, lookSummary, reactionsSummary, timelineSummary } from "@/blocks/visuals/designer/summaries";
import { instrumentsSummary, moodSummary, wordsSummary } from "./source/summaries";
import { startVisualizerReplica, visualizerBridgeSpec } from "./bridge";
import { useVisualizer } from "./store";
import { constituentItems } from "./VisualizerView";
import { followHostSeek } from "./PreviewPart";
import type { BridgeTransport } from "@/state/bridge";

const show = () => showFromPreset(presetById("spectrum-classic")!);
const analysis = buildFixture({ durationMs: 30_000 });

describe("designer summaries", () => {
  it("counts layers", () => {
    const s = show();
    const n = s.scenes[0]!.layers.length;
    expect(layersSummary(s)).toBe(`${n} ${n === 1 ? "layer" : "layers"}${s.scenes.length > 1 ? ` · ${s.scenes.length} scenes` : ""}`);
  });

  it("names the palette and the colour mode", () => {
    const s = show();
    expect(lookSummary({ ...s, palette: { mode: "fixed", ids: ["fire"] } })).toBe("Fire palette");
    expect(lookSummary({ ...s, palette: { mode: "journey", ids: ["fire", "ice", "neon"] } })).toBe("Journey of 3 palettes");
    expect(lookSummary({ ...s, palette: { mode: "mood", ids: ["fire"] } })).toBe("Mood colours");
  });

  it("names the first reaction and counts the rest", () => {
    const s = show();
    expect(s.controls.length).toBeGreaterThan(1);
    expect(reactionsSummary(s)).toMatch(/ → .+ \+\d+$/);
    expect(reactionsSummary({ ...s, controls: s.controls.slice(0, 1) })).toMatch(/ → [^+]+$/);
    expect(reactionsSummary({ ...s, controls: [] })).toBe("None yet");
  });

  it("says whether the timeline is automatic", () => {
    const s = show();
    expect(timelineSummary(s, analysis)).toBe(`Auto · ${analysis.audio.sections.length} sections`);
    expect(timelineSummary({ ...s, timeline: { mode: "manual", entries: [] } }, analysis)).toMatch(/^Manual · /);
  });
});

describe("source summaries", () => {
  it("describes words, instruments and mood", () => {
    expect(wordsSummary(DEFAULT_ANALYZE, null)).toBe("No words");
    expect(wordsSummary({ ...DEFAULT_ANALYZE, words: WordsSource.WordsDetect }, null)).toBe("Detect from the audio");
    expect(wordsSummary({ ...DEFAULT_ANALYZE, words: WordsSource.WordsFile, lyricsPath: "C:/m/lyrics.lrc" }, null)).toBe("lyrics.lrc");
    expect(wordsSummary({ ...DEFAULT_ANALYZE, words: WordsSource.WordsGiven }, "lyric-video")).toBe("From Lyric Video");
    expect(instrumentsSummary(DEFAULT_ANALYZE)).toBe("Separated");
    expect(instrumentsSummary({ ...DEFAULT_ANALYZE, saveStems: true })).toBe("Separated · saved");
    expect(instrumentsSummary({ ...DEFAULT_ANALYZE, stems: false })).toBe("Off");
    expect(moodSummary(DEFAULT_ANALYZE)).toBe("Needs words");
    expect(moodSummary({ ...DEFAULT_ANALYZE, words: WordsSource.WordsDetect, mood: true })).toBe("On");
    expect(moodSummary({ ...DEFAULT_ANALYZE, words: WordsSource.WordsDetect, mood: true, deepRead: true })).toBe("Deeper reading");
    expect(moodSummary({ ...DEFAULT_ANALYZE, words: WordsSource.WordsDetect, mood: false })).toBe("Off");
  });
});

describe("constituents", () => {
  it("offers the song in Stems and BPM & Key, each also in its own window", () => {
    const items = constituentItems("C:/m/song.mp3");
    expect(items.map((i) => i.id)).toEqual(["viz-stems", "viz-stems-window", "viz-bpm-key", "viz-bpm-key-window"]);
  });
});

describe("store bridge", () => {
  it("shares the design and song but not the analysis, and forwards only the playhead action", () => {
    const keys = Object.keys(visualizerBridgeSpec.pick(useVisualizer.getState()));
    expect(keys).toEqual(expect.arrayContaining(["input", "show", "ref", "aspect", "mode", "analyze", "playheadMs"]));
    expect(keys).not.toContain("analysis");
    expect(visualizerBridgeSpec.actions).toEqual(["setPlayheadMs"]);
  });

  it("a replica takes the host's snapshot and sends its playhead to the host", () => {
    const sent: unknown[] = [];
    let listener: ((p: unknown, from: string) => void) | null = null;
    const transport: BridgeTransport = {
      send: (p) => void sent.push(p),
      on: (cb) => {
        listener = cb;
        return () => undefined;
      },
    };
    useVisualizer.getState().reset();
    const dispose = startVisualizerReplica(transport);
    expect(sent[0]).toEqual({ t: "hello" });
    const s = show();
    listener!({ t: "snap", seq: 1, values: { ...visualizerBridgeSpec.pick(useVisualizer.getState()), input: "C:/m/song.mp3", show: s, aspect: 9 / 16 } }, "main");
    expect(useVisualizer.getState().input).toBe("C:/m/song.mp3");
    expect(useVisualizer.getState().show?.name).toBe(s.name);
    expect(useVisualizer.getState().aspect).toBeCloseTo(9 / 16);
    useVisualizer.getState().setPlayheadMs(4200);
    expect(sent.at(-1)).toEqual({ t: "call", action: "setPlayheadMs", args: [4200] });
    dispose();
    useVisualizer.getState().reset();
  });
});

describe("pop-out seek", () => {
  it("follows a host seek but not its own echo or small drift", () => {
    const seen: number[] = [];
    const seek = (ms: number) => void seen.push(ms);
    expect(followHostSeek(20_000, 5_000, [4_800, 5_000], seek)).toBe(true);
    expect(followHostSeek(5_100, 5_000, [], seek)).toBe(false);
    expect(followHostSeek(4_000, 5_000, [4_000], seek)).toBe(false); // our own earlier report coming back
    expect(seen).toEqual([20_000]);
  });
});

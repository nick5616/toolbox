import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    VisualizerService: { Fonts: async () => ["Arial"], Enqueue: async () => [], ChatStatus: async () => ({ model: "", ready: false }), MoodReaderReady: async () => true, Defaults: async () => ({}) },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    MediaService: { Open: async () => ({}), Frame: async () => "", Waveform: async () => [], URLFor: async () => "" },
    FilesService: { PickWith: async () => [], Pick: async () => [] },
    TranscribeService: { Languages: async () => [] },
    PacksService: { InstallFor: async () => ({}) },
    JobsService: { Cancel: async () => undefined },
  };
});

vi.mock("@/components/media", async (orig) => {
  const actual = await orig<typeof import("@/components/media")>();
  const React = await import("react");
  return {
    ...actual,
    useMediaSource: () => ({ status: "ready", source: { url: "/media/t/song.mp3", proxy: false, proxyJobId: "", info: { durationMs: 60000, hasCover: false, video: null, tags: { title: "Night Drive" } } }, retry() {} }),
    MediaPlayer: React.forwardRef(function Stub(_p: unknown, ref: React.Ref<unknown>) {
      React.useImperativeHandle(ref, () => ({ play() {}, pause() {}, toggle() {}, seek() {}, step() {}, currentMs: () => 0, playing: () => false }));
      return <div data-testid="own-player" />;
    }),
  };
});

vi.mock("@/viz/worker/encoder", () => ({ chooseEncoder: async () => ({ kind: "h264", label: "h264-hw", config: {} }) }));

vi.mock("@/components/viz", async () => {
  const { buildFixture } = await import("@/viz/fixture");
  const fixture = buildFixture({ durationMs: 30_000 });
  return {
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
    useVisualsAnalysis: () => ({ status: "ready", progress: 1, stage: "", ref: null, analysis: fixture, error: null, start() {}, cancel() {} }),
    VisualsPicker: () => null,
  };
});

vi.mock("@/blocks/visuals/songmap/SongMap", () => ({ SongMap: () => <div data-testid="songmap" /> }));

import { createStore } from "zustand/vanilla";
import { setCurrentWindowForTest, parseWindow } from "@/lib/windows";
import { getPart } from "@/parts/registry";
import { compositionInputs } from "@/state/composition";
import { hostBridge, resetBridgeStatusesForTest, type BridgeTransport } from "@/state/bridge";
import { useUI } from "@/state/ui";
import { setWorkspaceTransportForTest } from "@/workspace/defineWorkspace";
import { buildFixture } from "@/viz/fixture";
import { presetById, showFromPreset } from "@/viz/presets";
import { DEFAULT_EXPORT } from "./exportPrefs";
import { useVisualizer } from "./store";
import VisualizerView from "./VisualizerView";
import { visualizerBridge, visualizerWorkspace } from "./workspace";

const analysis = buildFixture({ durationMs: 30_000 });
const REF = {
  key: "k-1",
  audioJson: "",
  featuresPath: "",
  textJson: "",
  instrumental: "",
  summary: { durationMs: 30_000, tempo: 120, key: "A minor", sections: ["intro"], hasStems: true, hasWords: false, hasMeaning: false, moodSource: "music", language: "", lines: 0, warnings: null },
};

/** An analysed song, as if the analysis had just finished. */
function analysed() {
  useVisualizer.setState({ input: "C:/music/night-drive.mp3", isVideo: false, ref: REF, analysis, show: null });
}

beforeEach(() => {
  useVisualizer.getState().reset();
  useUI.setState({ handoff: null });
});

afterEach(() => {
  setWorkspaceTransportForTest(null);
  setCurrentWindowForTest(null);
  resetBridgeStatusesForTest();
});

describe("Visualizer workspace", () => {
  it("is the drop zone until a file arrives, then one workspace (no stepper)", async () => {
    render(<VisualizerView moduleId="visualizer" />);
    expect(await screen.findByText("Drop a song or video")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Steps" })).toBeNull();
    act(() => useUI.getState().handOff({ moduleId: "visualizer", inputs: ["C:/music/night-drive.mp3"] }));
    expect(await screen.findByRole("button", { name: "Source: night-drive.mp3" })).toBeTruthy();
    expect(useVisualizer.getState().input).toBe("C:/music/night-drive.mp3");
    // Nothing analysed yet: the stage shows the analysis, Export waits.
    expect(await screen.findByTestId("analysis-stage")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("header: source chip, design name, undo, redo, more, Export; the designer on the stage", async () => {
    analysed();
    render(<VisualizerView moduleId="visualizer" />);
    expect(await screen.findByRole("button", { name: "Source: night-drive.mp3" })).toBeTruthy();
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(header).getByRole("button", { name: "Redo" })).toBeTruthy();
    expect(within(header).getByRole("button", { name: "More" })).toBeTruthy();
    expect((within(header).getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(false);
    expect(await screen.findByRole("navigation", { name: "Designer" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Panels" })).toBeTruthy();
  });

  it("the source chip opens the Source panel (change file, video choice)", async () => {
    analysed();
    render(<VisualizerView moduleId="visualizer" />);
    await userEvent.click(await screen.findByRole("button", { name: "Source: night-drive.mp3" }));
    const dialog = await screen.findByRole("dialog", { name: "Source" });
    expect(await within(dialog).findByText("Night Drive")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Change" })).toBeTruthy();
  });

  it("the Analysis launcher opens words, instruments, mood and Re-analyse", async () => {
    analysed();
    render(<VisualizerView moduleId="visualizer" />);
    await userEvent.click(await screen.findByRole("button", { name: /^Analysis/ }));
    const dialog = await screen.findByRole("dialog", { name: "Analysis" });
    expect(await within(dialog).findByRole("radiogroup", { name: "Words" })).toBeTruthy();
    expect(within(dialog).getByRole("switch", { name: "Separate instruments" })).toBeTruthy();
    expect(within(dialog).getByRole("switch", { name: "Read the mood of the words" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Re-analyse" })).toBeTruthy();
    expect(within(dialog).getByText("120 BPM")).toBeTruthy();
  });

  it("Export opens the Export panel with size, quality, range and the render buttons", async () => {
    analysed();
    render(<VisualizerView moduleId="visualizer" />);
    await userEvent.click(await screen.findByRole("button", { name: "Export" }));
    const dialog = await screen.findByRole("dialog", { name: "Export" });
    expect(await within(dialog).findByRole("radiogroup", { name: "Aspect" })).toBeTruthy();
    expect(within(dialog).getByRole("radiogroup", { name: "Quality" })).toBeTruthy();
    expect(within(dialog).getByRole("radiogroup", { name: "Range" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Render video" })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("radio", { name: "720p" }));
    expect(useVisualizer.getState().exportPrefs.height).toBe(720);
  });

  it("a command's panel request opens that panel", async () => {
    analysed();
    render(<VisualizerView moduleId="visualizer" />);
    await screen.findByRole("button", { name: "Source: night-drive.mp3" });
    act(() => useVisualizer.getState().requestPanel("export"));
    expect(await screen.findByRole("dialog", { name: "Export" })).toBeTruthy();
    expect(useVisualizer.getState().panelRequest).toBeNull();
  });

  it("a design edit enables Undo, and Undo takes it back", async () => {
    analysed();
    render(<VisualizerView moduleId="visualizer" />);
    const header = (await screen.findByRole("banner")) as HTMLElement;
    const undo = within(header).getByRole("button", { name: "Undo" }) as HTMLButtonElement;
    const redo = within(header).getByRole("button", { name: "Redo" }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    const before = useVisualizer.getState().show?.name;
    await userEvent.click(await screen.findByRole("button", { name: /^Presets/ }));
    const other = presetById("spectrum-classic")!;
    const card = await screen.findByRole("button", { name: `card ${other.name}` });
    await userEvent.click(card);
    await waitFor(() => expect(undo.disabled).toBe(false));
    await waitFor(() => expect(useVisualizer.getState().show?.name).not.toBe(before));
    await userEvent.click(undo);
    await waitFor(() => expect(useVisualizer.getState().show?.name).toBe(before));
    expect(redo.disabled).toBe(false);
  });

  it("reports the song for the Uses chips (Stems, BPM & Key)", async () => {
    analysed();
    render(<VisualizerView moduleId="visualizer" />);
    await screen.findByRole("button", { name: "Source: night-drive.mp3" });
    expect(compositionInputs("visualizer", "stems")).toEqual(["C:/music/night-drive.mp3"]);
    expect(compositionInputs("visualizer", "bpm-key")).toEqual(["C:/music/night-drive.mp3"]);
  });
});

describe("Visualizer preview part over the workspace bridge", () => {
  it("a replica renders the preview from the host's store and sends its playhead back", async () => {
    const hub = new Map<string, Set<(p: unknown, from: string) => void>>();
    const endpoint = (key: string): BridgeTransport => ({
      send: (payload, to = "") => {
        const wire = JSON.parse(JSON.stringify(payload)) as unknown;
        for (const [k, set] of hub) {
          if (k === key || (to && to !== k)) continue;
          for (const cb of [...set]) cb(wire, key);
        }
      },
      on: (cb) => {
        const set = hub.get(key) ?? new Set();
        set.add(cb);
        hub.set(key, set);
        return () => set.delete(cb);
      },
    });
    setWorkspaceTransportForTest((side) => endpoint(side));
    setCurrentWindowForTest(parseWindow("?window=part&part=visualizer.preview&key=part:visualizer.preview"));

    const show = showFromPreset(presetById("spectrum-classic")!);
    const host = createStore<{ input: string | null; isVideo: boolean; mode: "full" | "overlay"; analyze: unknown; ref: unknown; show: unknown; aspect: number; renderSeed: number; playheadMs: number; setPlayheadMs(ms: number): void }>((set) => ({
      input: "C:/music/night-drive.mp3",
      isVideo: false,
      mode: "full",
      analyze: useVisualizer.getState().analyze,
      ref: REF,
      show,
      aspect: 16 / 9,
      renderSeed: 1,
      playheadMs: 0,
      setPlayheadMs: (ms) => set({ playheadMs: ms }),
    }));
    const stop = hostBridge(host as never, { name: visualizerWorkspace.bridgeName, pick: visualizerBridge.pick as never, apply: visualizerBridge.apply as never, actions: ["setPlayheadMs"] as never }, endpoint("host"));

    const part = getPart("visualizer.preview")!;
    const disconnect = await part.connect!(new URLSearchParams());
    const Part = part.component;
    render(<Part placement="window" />);
    expect(await screen.findByTestId("canvas")).toBeTruthy();
    expect(useVisualizer.getState().input).toBe("C:/music/night-drive.mp3");
    act(() => useVisualizer.getState().setPlayheadMs(4200));
    await waitFor(() => expect(host.getState().playheadMs).toBe(4200));
    disconnect();
    stop();
    expect(DEFAULT_EXPORT.height).toBe(1080);
  });
});

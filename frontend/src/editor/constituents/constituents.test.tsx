import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClickInHost } from "@/components";
import { ModuleStatus, type Descriptor } from "@/lib/api";
import { useEmbed } from "@/lib/embed";
import { registerToolViews } from "@/lib/toolActions";
import { compositionInputs } from "@/state/composition";
import { useModules } from "@/state/modules";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { MusicInspector } from "../inspector/MusicInspector";
import { SelectionBar, fitChips } from "../selection/SelectionBar";
import "../panelDefs";
import { findClip } from "../doc";
import { EditorProfileProvider, PLAIN_PROFILE } from "../profileContext";
import { useEditStudio, type Selection } from "../store";
import { clipToolChips } from "./toolChips";
import { useEditorComposition } from "./useEditorComposition";
import { replaceBedFile } from "./replaceSource";

const prepare = vi.hoisted(() => vi.fn(async (_p: string[]) => undefined));
vi.mock("../sources/actions", async (orig) => ({ ...(await orig<typeof import("../sources/actions")>()), prepare }));
vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 0, height: 0 }) }));
vi.mock("@/lib/api", async (orig) => {
  const m = await orig<typeof import("@/lib/api")>();
  return {
    ...m,
    FilesService: { ...m.FilesService, Stat: async (paths: string[]) => paths.map((path) => ({ path, exists: !path.includes("gone"), isDir: false })) },
    EditStudioService: {
      ...m.EditStudioService,
      Fonts: async () => ["Inter"],
      InterpFor: async () => null,
      Probe: async (paths: string[]) => paths.map((path) => ({ path, kind: /\.(wav|flac)$/.test(path) ? "audio" : /\.jpg|\.png/.test(path) ? "image" : "video", durationMs: 60_000, error: "" })),
    },
  };
});
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components", async (orig) => ({ ...(await orig<typeof import("@/components")>()), toast }));

const st = () => useEditStudio.getState();
const clip = (id: string) => findClip(st().history!.present, id)!.clip;

function desc(id: string, name: string): Descriptor {
  return { id, name, icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: [], urls: false, any: false } } as unknown as Descriptor;
}

function FakeTool({ result }: { result: string }) {
  const e = useEmbed();
  return (
    <div>
      <p>inputs: {(e?.handoff.inputs ?? []).join(",")}</p>
      <button type="button" onClick={() => e?.onUse?.([result])}>
        {e?.useLabel}
      </button>
    </div>
  );
}

function open(selection: Selection) {
  st().close();
  st().open("p1", "Test", normalizeProject(fixtureProject()));
  st().select(selection);
}

function bar() {
  return render(
    <EditorProfileProvider profile={PLAIN_PROFILE}>
      <ClickInHost>
        <SelectionBar />
      </ClickInHost>
    </EditorProfileProvider>,
  );
}

beforeEach(() => {
  toast.mockClear();
  prepare.mockClear();
  useModules.getState().setAll([desc("upscaler", "Upscale"), desc("audio-cleanup", "Clean audio"), desc("stems", "Stem Splitter"), desc("video-studio", "Video Editor")]);
  registerToolViews({
    upscaler: () => <FakeTool result="/out/photo-up.png" />,
    "audio-cleanup": () => <FakeTool result="/out/a-clean.mp4" />,
    stems: () => <FakeTool result="/out/vocals.flac" />,
  });
});
afterEach(cleanup);

const launchers = () => screen.queryAllByRole("button").map((b) => b.textContent ?? "");

describe("constituent chips", () => {
  it("appear only for the right clip kinds", () => {
    expect(clipToolChips({ kind: "image", path: "a.jpg" }).map((c) => c.module)).toEqual(["upscaler"]);
    expect(clipToolChips({ kind: "video", path: "a.mp4" }).map((c) => c.module)).toEqual(["audio-cleanup"]);
    expect(clipToolChips({ kind: "text", path: "" })).toEqual([]);
    expect(clipToolChips({ kind: "color", path: "" })).toEqual([]);
    open({ kind: "clips", ids: ["c2"] });
    bar();
    expect(launchers().some((t) => t.includes("Upscale"))).toBe(true);
    expect(launchers().some((t) => t.includes("Clean audio"))).toBe(false);
    cleanup();
    open({ kind: "clips", ids: ["c1"] });
    bar();
    expect(launchers().some((t) => t.includes("Clean audio"))).toBe(true);
    expect(launchers().some((t) => t.includes("Upscale"))).toBe(false);
  });

  it("stay reachable in More… when the bar is narrow", () => {
    const chips = [
      { panel: "clip-transform", summary: "Default" },
      { panel: "clip-effects", summary: "None" },
      { panel: "tool:audio-cleanup", summary: "", title: "Clean audio" },
    ];
    const r = fitChips(chips, 200);
    expect(r.shown).toBeLessThan(chips.length);
    expect(fitChips(chips, 2000)).toEqual({ shown: 3, summaries: true });
  });
});

describe("Use from Upscale", () => {
  it("replaces one clip's source in one undo step, adding the file as a source", async () => {
    open({ kind: "clips", ids: ["c2"] });
    bar();
    const before = st().history!.past.length;
    await userEvent.click(screen.getByRole("button", { name: /Upscale/ }));
    expect(await screen.findByText("inputs: /fixture/photo.jpg")).toBeTruthy();
    await userEvent.click(screen.getByText("Use for this clip"));
    await waitFor(() => expect(clip("c2").path).toBe("/out/photo-up.png"));
    expect(st().history!.past.length).toBe(before + 1);
    expect(st().history!.present.sources.some((s) => s.path === "/out/photo-up.png")).toBe(true);
    expect(prepare).toHaveBeenCalledWith(["/out/photo-up.png"]);
    st().undo();
    expect(clip("c2").path).toBe("/fixture/photo.jpg");
  });

  it("asks when other clips share the source: Just this clip leaves them alone", async () => {
    open({ kind: "clips", ids: ["c2"] });
    const doc = st().history!.present;
    const c2 = clip("c2");
    st().edit({ ...doc, tracks: doc.tracks.map((t) => (t.id === "t1" ? { ...t, clips: [...t.clips, { ...c2, id: "c9", startMs: 30_000, endMs: 32_000 }] } : t)) }, "");
    bar();
    await userEvent.click(screen.getByRole("button", { name: /Upscale/ }));
    await userEvent.click(await screen.findByText("Use for this clip"));
    await userEvent.click(await screen.findByText("Just this clip"));
    await waitFor(() => expect(clip("c2").path).toBe("/out/photo-up.png"));
    expect(clip("c9").path).toBe("/fixture/photo.jpg");
  });

  it("Replace in all changes every clip with that file", async () => {
    open({ kind: "clips", ids: ["c2"] });
    const doc = st().history!.present;
    const c2 = clip("c2");
    st().edit({ ...doc, tracks: doc.tracks.map((t) => (t.id === "t1" ? { ...t, clips: [...t.clips, { ...c2, id: "c9", startMs: 30_000, endMs: 32_000 }] } : t)) }, "");
    bar();
    await userEvent.click(screen.getByRole("button", { name: /Upscale/ }));
    await userEvent.click(await screen.findByText("Use for this clip"));
    await userEvent.click(await screen.findByText("Replace in all"));
    await waitFor(() => expect(clip("c9").path).toBe("/out/photo-up.png"));
    expect(clip("c2").path).toBe("/out/photo-up.png");
  });

  it("says the file is gone when the result no longer exists", async () => {
    registerToolViews({ upscaler: () => <FakeTool result="/out/gone.png" /> });
    open({ kind: "clips", ids: ["c2"] });
    bar();
    await userEvent.click(screen.getByRole("button", { name: /Upscale/ }));
    await userEvent.click(await screen.findByText("Use for this clip"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "That file is gone" })));
    expect(clip("c2").path).toBe("/fixture/photo.jpg");
  });
});

describe("Use from Clean audio", () => {
  it("replaces the video clip's source and keeps trims, speed and effects", async () => {
    open({ kind: "clips", ids: ["c1"] });
    const before = clip("c1");
    bar();
    await userEvent.click(screen.getByRole("button", { name: /Clean audio/ }));
    expect(await screen.findByText("inputs: /fixture/a.mp4")).toBeTruthy();
    await userEvent.click(screen.getByText("Use for this clip"));
    await waitFor(() => expect(clip("c1").path).toBe("/out/a-clean.mp4"));
    const after = clip("c1");
    expect({ ...after, path: "" }).toEqual({ ...before, path: "" });
  });
});

describe("Split into stems", () => {
  function music(profile = PLAIN_PROFILE) {
    return render(
      <EditorProfileProvider profile={profile}>
        <ClickInHost>
          <MusicInspector />
        </ClickInHost>
      </EditorProfileProvider>,
    );
  }

  it("Use as music sets the bed's file and keeps range, gain and fades", async () => {
    open(null);
    const doc = st().history!.present;
    st().edit({ ...doc, song: { ...doc.song!, startMs: 1000, endMs: 9000, gainDb: -3, fadeInMs: 200, fadeOutMs: 400 } }, "");
    music();
    await userEvent.click(screen.getByRole("button", { name: /Split into stems/ }));
    expect(await screen.findByText("inputs: /fixture/song.wav")).toBeTruthy();
    await userEvent.click(screen.getByText("Use as music"));
    await waitFor(() => expect(st().history!.present.song?.path).toBe("/out/vocals.flac"));
    expect(st().history!.present.song).toMatchObject({ startMs: 1000, endMs: 9000, gainDb: -3, fadeInMs: 200, fadeOutMs: 400 });
  });

  it("isn't offered for Edit Studio's analysed song", () => {
    open(null);
    music({ ...PLAIN_PROFILE, moduleId: "edit-studio", song: "analyzed" });
    expect(screen.queryByRole("button", { name: /Split into stems/ })).toBeNull();
  });

  it("clamps the range to a shorter stem", () => {
    open(null);
    const doc = st().history!.present;
    const next = replaceBedFile({ ...doc, song: { ...doc.song!, startMs: 0, endMs: 9000 } }, "/s.flac", 5000);
    expect(next.song).toMatchObject({ path: "/s.flac", startMs: 0, endMs: 5000 });
  });
});

describe("composition inputs", () => {
  it("reports the selected clip and the song for the parts", () => {
    open({ kind: "clips", ids: ["c2"] });
    renderHook(() => useEditorComposition({ ...PLAIN_PROFILE, moduleId: "video-studio" }));
    expect(compositionInputs("video-studio", "upscaler")).toEqual(["/fixture/photo.jpg"]);
    expect(compositionInputs("video-studio", "bg-remover")).toEqual(["/fixture/photo.jpg"]);
    expect(compositionInputs("video-studio", "audio-cleanup")).toEqual([]);
    expect(compositionInputs("video-studio", "stems")).toEqual(["/fixture/song.wav"]);
    expect(compositionInputs("video-studio", "transcribe")).toEqual([]);
  });

  it("adds the song for the music parts of Edit Studio and the audio clip for Clean audio", () => {
    open({ kind: "clips", ids: ["c1"] });
    renderHook(() => useEditorComposition({ ...PLAIN_PROFILE, moduleId: "edit-studio", song: "analyzed" }));
    expect(compositionInputs("edit-studio", "audio-cleanup")).toEqual(["/fixture/a.mp4"]);
    expect(compositionInputs("edit-studio", "visualizer")).toEqual(["/fixture/song.wav"]);
    expect(compositionInputs("edit-studio", "transcribe")).toEqual(["/fixture/song.wav"]);
  });
});

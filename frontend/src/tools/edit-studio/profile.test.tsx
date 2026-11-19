import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  markers: [] as Array<{ id: string; lane: string; ms: number; strength: number }>,
  exportMarkers: vi.fn(),
  exportSrt: vi.fn(),
}));

vi.mock("@/editor/store", async (orig) => {
  const actual = await orig<typeof import("@/editor/store")>();
  return { ...actual, useMarkers: () => h.markers };
});
vi.mock("./lanes/exportMarkers", () => ({ exportMarkers: (...a: unknown[]) => h.exportMarkers(...a) }));
vi.mock("./captions/exportSrt", () => ({ exportSrt: (...a: unknown[]) => h.exportSrt(...a) }));

import { useCommandRegistry } from "@/lib/commands";
import { emptyEditProject, type NormalProject } from "@/viz/edit/defaults";
import { newClip } from "@/editor/doc";
import { useNewEditRequest } from "@/editor/home/newEditRequest";
import { EditorProfileProvider } from "@/editor/profileContext";
import { useEditStudio } from "@/editor/store";
import { useEditCommands } from "@/editor/transport/commands";
import { MUSIC_EDIT_PROFILE } from "./profile";
import { VIDEO_PROFILE } from "../video-studio/profile";

function Harness() {
  useEditCommands();
  return null;
}
const mount = () =>
  render(
    <EditorProfileProvider profile={MUSIC_EDIT_PROFILE}>
      <Harness />
    </EditorProfileProvider>,
  );

const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(window, { key: k, ...init });
const project = () => useEditStudio.getState().history!.present;
const spans = () => (project().tracks[0]?.clips ?? []).slice().sort((a, b) => a.startMs - b.startMs).map((c) => [c.startMs, c.endMs]);

function openEdit(): void {
  const doc = emptyEditProject("9:16", 30, 1) as NormalProject;
  doc.song = { path: "/s.mp3", startMs: 0, endMs: 20_000, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 };
  doc.tracks = [
    { id: "t1", kind: "video", name: "Video 1", muted: false, locked: false, matte: "", clips: [newClip({ id: "a", kind: "video", path: "/a.mp4", startMs: 0, endMs: 4000 }), newClip({ id: "b", kind: "video", path: "/b.mp4", startMs: 5000, endMs: 6000 })] },
    { id: "t2", kind: "adjust", name: "Adjust 1", muted: false, locked: false, matte: "", clips: [] },
  ];
  useEditStudio.getState().open("p1", "Edit", doc);
  useEditStudio.getState().setAnalysis(null, {} as never, "ready");
}

beforeEach(() => {
  h.markers = [1000, 2000, 3000, 4500].map((ms) => ({ id: `kick:${ms}`, lane: "kick", ms, strength: 1 }));
  h.exportMarkers.mockReset();
  h.exportSrt.mockReset();
  useEditStudio.getState().close();
  useNewEditRequest.setState({ pending: null, songReplace: null });
  openEdit();
  useEditStudio.getState().setActiveLane("kick");
});
afterEach(cleanup);

describe("MUSIC_EDIT_PROFILE", () => {
  it("is the analysed, marker-aware profile with the music layer's slots", () => {
    const p = MUSIC_EDIT_PROFILE;
    expect(p).toMatchObject({ moduleId: "edit-studio", song: "analyzed", homeFilter: "music-edit", markerSignals: true });
    for (const slot of ["HeaderStart", "HeaderEnd", "moreItems", "Setup", "TimelineTop", "TracksToolbar", "TracksOverlay", "clipMenuItems", "useSnapMarkers", "Dialogs", "useCommands"] as const) {
      expect(p[slot], slot).toBeTruthy();
    }
    expect(p.inspector).toMatchObject({ SourceExtras: expect.anything(), PostExtras: expect.anything() });
    expect(p.rail).toEqual(["media", "song", "markers", "captions", "style", "project"]);
    expect(p).toMatchObject({ songPanel: "song", markersPanel: "markers" });
  });

  it("the Video Editor's profile plugs in nothing", () => {
    expect(VIDEO_PROFILE).toMatchObject({ moduleId: "video-studio", song: "optional", homeFilter: "all", markerSignals: false });
    expect(VIDEO_PROFILE.TimelineTop).toBeUndefined();
    expect(VIDEO_PROFILE.Setup).toBeUndefined();
    expect(VIDEO_PROFILE.inspector).toBeUndefined();
  });

  it("More items: the marker and caption exports", () => {
    const project = openedProject();
    const items = MUSIC_EDIT_PROFILE.moreItems?.({ disabled: false, project }) ?? [];
    expect(items.map((i) => i.id)).toEqual(["markers-csv", "markers-json", "srt"]);
    expect(items[2]?.disabled).toBe(true); // no captions
    items[0]?.onSelect();
    items[1]?.onSelect();
    expect(h.exportMarkers.mock.calls.map((c) => c[0])).toEqual(["csv", "json"]);
    expect(MUSIC_EDIT_PROFILE.moreItems?.({ disabled: true, project })[0]?.disabled).toBe(true);
  });

  it("clip menu items: slice, slice and cycle, style", () => {
    const items = MUSIC_EDIT_PROFILE.clipMenuItems?.([], { markers: [] }) ?? [];
    expect(items.map((i) => i.id)).toEqual(["slice", "cycle", "style"]);
    expect(items[0]?.label).toBe("Slice at kick markers");
    expect(items[1]?.disabled).toBe(true); // fewer than two sources
  });
});

function openedProject(): NormalProject {
  return project();
}

describe("music commands (registered through the profile)", () => {
  const cmd = (id: string) => useCommandRegistry.getState().commands[`edit-studio.${id}`];

  it("Shift+S slices the selection at the active lane's markers", () => {
    mount();
    useEditStudio.getState().select({ kind: "clips", ids: ["a"] });
    key("S", { shiftKey: true });
    expect(spans()).toEqual([[0, 1000], [1000, 2000], [2000, 3000], [3000, 4000], [5000, 6000]]);
  });

  it("registers the Edit Studio section: the editor's commands and the music layer's", () => {
    mount();
    const ids = Object.keys(useCommandRegistry.getState().commands)
      .filter((k) => k.startsWith("edit-studio."))
      .sort();
    expect(ids).toEqual(
      ["add-adjust-track", "add-audio-track", "add-track", "autofill", "export", "markers-csv", "markers-json", "new", "safe-zones", "slice", "slice-cycle", "snap", "split-subject", "srt", "zoom-fit"].map((s) => `edit-studio.${s}`).sort(),
    );
    expect(cmd("autofill")?.section).toBe("Edit Studio");
    expect(cmd("new")?.title).toBe("New edit");
  });

  it("Auto-fill and Export open their dialogs; Auto-fill takes a selected range; both need a ready analysis", async () => {
    mount();
    await cmd("export")?.run();
    expect(useEditStudio.getState().dialog).toEqual({ kind: "export" });
    useEditStudio.getState().select({ kind: "range", fromMs: 1000, toMs: 3000 });
    await cmd("autofill")?.run();
    expect(useEditStudio.getState().dialog).toEqual({ kind: "autofill", range: { fromMs: 1000, toMs: 3000 } });
    act(() => useEditStudio.getState().setAnalysis(null, null, "none"));
    expect(cmd("export")?.enabled?.()).toBe(false);
    expect(cmd("autofill")?.enabled?.()).toBe(false);
  });

  it("markers and SRT exports call the owners' functions", async () => {
    mount();
    await cmd("markers-csv")?.run();
    await cmd("markers-json")?.run();
    expect(h.exportMarkers.mock.calls.map((c) => c[0])).toEqual(["csv", "json"]);
    expect(cmd("srt")?.enabled?.()).toBe(false); // no captions
  });

  it("Slice at markers needs a selection", async () => {
    mount();
    await cmd("slice")?.run();
    expect(spans()).toEqual([[0, 4000], [5000, 6000]]);
    useEditStudio.getState().select({ kind: "clips", ids: ["a"] });
    await cmd("slice")?.run();
    expect(spans()).toHaveLength(5);
  });

  it("Slice and cycle sources swaps later slices to the next source", async () => {
    mount();
    const d = project();
    useEditStudio.getState().edit({ ...d, sources: [{ path: "/a.mp4", tags: [] }, { path: "/b.mp4", tags: [] }] });
    useEditStudio.getState().setSources([
      { path: "/a.mp4", info: { path: "/a.mp4", kind: "video", durationMs: 30_000 } as never, preview: null, image: "", shots: null, preparing: false, error: "" },
      { path: "/b.mp4", info: { path: "/b.mp4", kind: "video", durationMs: 30_000 } as never, preview: null, image: "", shots: null, preparing: false, error: "" },
    ]);
    useEditStudio.getState().select({ kind: "clips", ids: ["a"] });
    await cmd("slice-cycle")?.run();
    const paths = (project().tracks[0]?.clips ?? []).filter((c) => c.endMs <= 4000).sort((x, y) => x.startMs - y.startMs).map((c) => c.path);
    expect(paths).toEqual(["/a.mp4", "/b.mp4", "/a.mp4", "/b.mp4"]);
  });

  it("the music commands go away with the editor", () => {
    const { unmount } = mount();
    unmount();
    expect(cmd("autofill")).toBeUndefined();
  });
});

describe("Auto-fill button", () => {
  it("opens the dialog for the selected range", async () => {
    const Button = MUSIC_EDIT_PROFILE.HeaderEnd;
    if (!Button) throw new Error("no HeaderEnd");
    useEditStudio.getState().select({ kind: "range", fromMs: 500, toMs: 900 });
    render(<Button disabled={false} />);
    await userEvent.click(screen.getByRole("button", { name: /auto-fill/i }));
    expect(useEditStudio.getState().dialog).toEqual({ kind: "autofill", range: { fromMs: 500, toMs: 900 } });
  });
});

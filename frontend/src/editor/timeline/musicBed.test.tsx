import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ probe: vi.fn(), pick: vi.fn(), library: vi.fn() }));

vi.mock("@/blocks/library-picker", async (orig) => {
  const actual = await orig<typeof import("@/blocks/library-picker")>();
  return { ...actual, pickFromLibrary: (...a: unknown[]) => h.library(...a) };
});

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    EditStudioService: { Probe: (...a: unknown[]) => h.probe(...a), Sources: async () => [], Mattes: async () => [] },
    FilesService: { PickWith: (...a: unknown[]) => h.pick(...a) },
  };
});
vi.mock("@/blocks/media/useThumbs", () => ({ useThumb: () => "", useWaveform: () => [] }));

import { emptyEditProject, type NormalProject } from "@/viz/edit/defaults";
import { newClip } from "@/editor/doc";
import { useEditStudio } from "@/editor/store";
import { MusicInspector } from "../inspector/MusicInspector";
import { EditorProfileProvider, PLAIN_PROFILE } from "../profileContext";
import { addMusic, addMusicFromLibrary, bedFor, clipsEndMs, removeMusic, timelineRoomMs } from "./songFile";
import { SongTrack } from "./SongTrack";

function doc(clipEnds: number[], song = false): NormalProject {
  const p = emptyEditProject("9:16", 30, 1) as NormalProject;
  p.tracks = [{ id: "t1", kind: "video", name: "Video 1", muted: false, locked: false, matte: "", clips: clipEnds.map((end, i) => newClip({ id: `c${i}`, kind: "video", path: "/a.mp4", startMs: i === 0 ? 0 : clipEnds[i - 1] ?? 0, endMs: end })) }];
  if (song) p.song = { path: "/m.mp3", startMs: 0, endMs: 5000, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 };
  return p;
}
const project = () => useEditStudio.getState().history!.present;

beforeEach(() => {
  h.probe.mockReset();
  h.pick.mockReset();
  h.library.mockReset();
  useEditStudio.getState().close();
});
afterEach(cleanup);

describe("music bed record", () => {
  it("is as long as the clips (at least 1 s), capped by the file and 10 minutes", () => {
    expect(bedFor(doc([8000]), "/m.mp3", 200_000)).toMatchObject({ path: "/m.mp3", startMs: 0, endMs: 8000, gainDb: 0 });
    expect(bedFor(doc([8000]), "/m.mp3", 5000).endMs).toBe(5000); // the file is shorter than the clips
    expect(bedFor(doc([]), "/m.mp3", 200_000).endMs).toBe(200_000); // no clips: the whole file
    expect(bedFor(doc([]), "/m.mp3", 900_000).endMs).toBe(600_000);
    expect(bedFor(doc([400]), "/m.mp3", 60_000).endMs).toBe(1000);
  });

  it("clipsEndMs is the last clip end over all tracks", () => {
    expect(clipsEndMs(doc([]))).toBe(0);
    expect(clipsEndMs(doc([3000, 9000]))).toBe(9000);
  });
});

describe("timeline room", () => {
  it("is the edit itself with a song; without one, 30 s of room and at least 60 s", () => {
    expect(timelineRoomMs(doc([8000], true))).toBe(5000);
    expect(timelineRoomMs(doc([8000]))).toBe(60_000);
    expect(timelineRoomMs(doc([50_000]))).toBe(80_000);
    expect(timelineRoomMs(doc([]))).toBe(60_000);
  });
});

describe("Add music", () => {
  it("picks an audio file, probes it and sets the bed; Remove takes it out and can be undone", async () => {
    useEditStudio.getState().open("p1", "V", doc([8000]));
    h.pick.mockResolvedValue(["/c/song.mp3"]);
    h.probe.mockResolvedValue([{ path: "/c/song.mp3", kind: "audio", durationMs: 120_000, error: "" }]);
    await addMusic();
    expect(h.pick).toHaveBeenCalledWith("Add music", expect.arrayContaining([".mp3"]), false);
    expect(project().song).toMatchObject({ path: "/c/song.mp3", startMs: 0, endMs: 8000 });
    removeMusic();
    expect(project().song).toBeNull();
    useEditStudio.getState().undo();
    expect(project().song?.path).toBe("/c/song.mp3");
  });

  it("From Library sets the bed exactly like the native pick, with one file and the song extensions", async () => {
    useEditStudio.getState().open("p1", "V", doc([8000]));
    h.library.mockResolvedValue(["/lib/song.mp3"]);
    h.probe.mockResolvedValue([{ path: "/lib/song.mp3", kind: "audio", durationMs: 120_000, error: "" }]);
    await addMusicFromLibrary();
    expect(h.library).toHaveBeenCalledWith(expect.objectContaining({ multiple: false, exts: expect.arrayContaining([".mp3"]) }));
    expect(h.pick).not.toHaveBeenCalled();
    expect(project().song).toMatchObject({ path: "/lib/song.mp3", startMs: 0, endMs: 8000 });
    h.library.mockResolvedValue([]); // cancelled: nothing changes
    await addMusicFromLibrary();
    expect(project().song?.path).toBe("/lib/song.mp3");
  });

  it("leaves the edit alone when the file is too short or the picker is cancelled", async () => {
    useEditStudio.getState().open("p1", "V", doc([8000]));
    h.pick.mockResolvedValue([]);
    await addMusic();
    h.pick.mockResolvedValue(["/c/blip.wav"]);
    h.probe.mockResolvedValue([{ path: "/c/blip.wav", kind: "audio", durationMs: 200, error: "" }]);
    await addMusic();
    expect(project().song).toBeNull();
  });
});

describe("the song row", () => {
  function row() {
    return (
      <EditorProfileProvider profile={PLAIN_PROFILE}>
        <SongTrack timeWidth={600} />
      </EditorProfileProvider>
    );
  }

  it("shows no row while the edit has no music (Add music lives in the Music panel)", () => {
    useEditStudio.getState().open("p1", "V", doc([8000]));
    const { container } = render(row());
    expect(container.querySelector("[data-song-row]")).toBeNull();
  });

  it("the Music panel offers Add music while there is none, and the button adds it", async () => {
    useEditStudio.getState().open("p1", "V", doc([8000]));
    h.pick.mockResolvedValue(["/c/song.mp3"]);
    h.probe.mockResolvedValue([{ path: "/c/song.mp3", kind: "audio", durationMs: 30_000, error: "" }]);
    render(<MusicInspector />);
    await userEvent.click(screen.getByRole("button", { name: "Add music" }));
    await waitFor(() => expect(project().song?.path).toBe("/c/song.mp3"));
  });

  it("an analysed profile shows nothing without a song", () => {
    useEditStudio.getState().open("p1", "V", doc([8000]));
    const { container } = render(
      <EditorProfileProvider profile={{ ...PLAIN_PROFILE, song: "analyzed" }}>
        <SongTrack timeWidth={600} />
      </EditorProfileProvider>,
    );
    expect(container.querySelector("[data-song-row]")).toBeNull();
  });
});

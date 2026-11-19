import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  open: vi.fn(),
  probe: vi.fn(),
  pickWith: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    MediaService: { Open: (...a: unknown[]) => h.open(...a), URLFor: async () => "/media/t/x" },
    EditStudioService: { Probe: (...a: unknown[]) => h.probe(...a), Sources: async () => [], Mattes: async () => [] },
    FilesService: { PickWith: (...a: unknown[]) => h.pickWith(...a) },
  };
});

import { emptyEditProject, type NormalProject } from "@/viz/edit/defaults";
import { newClip } from "@/editor/doc";
import { useEditStudio } from "@/editor/store";
import { getPlayer } from "./player";
import { Transport } from "./Transport";

const source = { url: "/media/t/song.mp3", proxy: false, proxyJobId: "", info: { durationMs: 200_000, startMs: 0, container: "mp3", sizeBytes: 1, bitRate: 0, audio: [], subtitles: [], hasCover: false } };

function openEdit(startMs = 10_000, endMs = 30_000): void {
  const doc = emptyEditProject("9:16", 30, 1) as NormalProject;
  doc.song = { path: "/song.mp3", startMs, endMs, gainDb: 0, fadeInMs: 0, fadeOutMs: 500 };
  useEditStudio.getState().open("p1", "Edit", doc);
}
/** An edit with no song: one video clip, 4 s. */
function openSongless(): void {
  const doc = emptyEditProject("9:16", 30, 1) as NormalProject;
  doc.tracks = [{ id: "t1", kind: "video", name: "V", muted: false, locked: false, matte: "", clips: [newClip({ id: "a", kind: "video", path: "/a.mp4", startMs: 0, endMs: 4000 })] }];
  useEditStudio.getState().open("p1", "Edit", doc);
}
const project = () => useEditStudio.getState().history!.present;

beforeEach(() => {
  h.open.mockReset();
  h.probe.mockReset();
  h.pickWith.mockReset();
  h.open.mockResolvedValue(source);
  useEditStudio.getState().close();
});
afterEach(cleanup);

describe("Transport", () => {
  it("shows the timecode as HH:MM:SS:FF with the edit's length", () => {
    openEdit(10_000, 30_000);
    render(<Transport />);
    expect(screen.getByLabelText("Time").textContent).toBe("00:00:00:00");
    expect(screen.getByText("/ 00:00:20:00")).toBeTruthy();
  });

  it("plays and pauses without a song; the store follows", async () => {
    openSongless();
    render(<Transport />);
    const play = screen.getByRole("button", { name: "Play" });
    expect(play.getAttribute("disabled")).toBeNull();
    await userEvent.click(play);
    expect(useEditStudio.getState().playing).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(useEditStudio.getState().playing).toBe(false);
  });

  it("registers a controller for the shortcuts, with reverse and loop", async () => {
    openEdit();
    const { unmount } = render(<Transport />);
    const p = getPlayer();
    expect(p).toBeTruthy();
    p?.seek(4000);
    expect(useEditStudio.getState().playheadMs).toBe(4000);
    p?.reverse();
    expect(useEditStudio.getState().playing).toBe(true);
    expect(p?.rate()).toBe(-1);
    p?.reverse();
    expect(p?.rate()).toBe(-2);
    p?.pause();
    expect(useEditStudio.getState().playing).toBe(false);
    p?.loop({ inMs: 1000, outMs: 2000 });
    unmount();
    expect(getPlayer()).toBeNull();
  });

  it("moves the playhead when it is set from outside", () => {
    openEdit();
    render(<Transport />);
    act(() => useEditStudio.getState().setPlayhead(7000));
    expect(getPlayer()?.rate()).toBe(1);
    expect(screen.getByLabelText("Time").textContent).toBe("00:00:07:00");
  });

  it("click the time, type one and press Enter to seek; a bad time is refused", async () => {
    openSongless();
    render(<Transport />);
    await userEvent.click(screen.getByLabelText("Time"));
    const box = screen.getByLabelText("Go to time");
    await userEvent.clear(box);
    await userEvent.type(box, "nope{Enter}");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    await userEvent.clear(box);
    await userEvent.type(box, "00:00:02:15{Enter}");
    expect(useEditStudio.getState().playheadMs).toBe(2500);
    expect(screen.queryByLabelText("Go to time")).toBeNull();
  });

  it("Draft / Full quality toggles in the store", async () => {
    openEdit();
    render(<Transport />);
    expect(useEditStudio.getState().previewQuality).toBe("draft");
    await userEvent.click(screen.getByRole("button", { name: "Draft" }));
    expect(useEditStudio.getState().previewQuality).toBe("full");
    await userEvent.click(screen.getByRole("button", { name: "Full" }));
    expect(useEditStudio.getState().previewQuality).toBe("draft");
  });

  it("scrub audio is a toggle in the More menu", async () => {
    openEdit();
    render(<Transport />);
    expect(useEditStudio.getState().scrubAudio).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "More transport options" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Scrub audio: on/ }));
    expect(useEditStudio.getState().scrubAudio).toBe(false);
  });

  it("minimal controls: snap, zoom and fit; nothing music-specific", async () => {
    openEdit();
    render(<Transport />);
    // Lane, Cut offset and Safe zones moved into panels (Markers, Project).
    expect(screen.queryByRole("combobox", { name: "Active lane" })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "Cut offset in frames" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Safe zones" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Snap" }));
    expect(useEditStudio.getState().snap).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Snap" }));
    expect(useEditStudio.getState().snap).toBe(true);
    const pps = useEditStudio.getState().pps;
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(useEditStudio.getState().pps).toBeCloseTo(pps * 1.5);
    await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(useEditStudio.getState().pps).toBeCloseTo(pps);
    await userEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(useEditStudio.getState().scrollMs).toBe(0);
  });

  it("a missing song shows a banner; Find the song keeps the range when the new file still holds it", async () => {
    h.open.mockRejectedValue(new Error("not found"));
    openEdit(0, 60_000);
    h.pickWith.mockResolvedValue(["/new/song.mp3"]);
    h.probe.mockResolvedValue([{ path: "/new/song.mp3", kind: "audio", durationMs: 60_500, error: "" }]);
    render(<Transport />);
    expect(await screen.findByText("The song file is missing")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Find the song…" }));
    await waitFor(() => expect(project().song?.path).toBe("/new/song.mp3"));
    expect(project().song).toMatchObject({ startMs: 0, endMs: 60_000 });
  });

  it("Find the song resets the range when the new file is shorter", async () => {
    h.open.mockRejectedValue(new Error("not found"));
    openEdit(0, 60_000);
    h.pickWith.mockResolvedValue(["/new/short.mp3"]);
    h.probe.mockResolvedValue([{ path: "/new/short.mp3", kind: "audio", durationMs: 20_000, error: "" }]);
    render(<Transport />);
    await userEvent.click(await screen.findByRole("button", { name: "Find the song…" }));
    await waitFor(() => expect(project().song?.path).toBe("/new/short.mp3"));
    expect(project().song).toMatchObject({ startMs: 0, endMs: 20_000 });
  });
});

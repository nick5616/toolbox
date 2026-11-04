import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  open: vi.fn(),
  probe: vi.fn(),
  pickWith: vi.fn(),
  player: {
    props: null as null | {
      source: { url: string; info: { startMs: number; durationMs: number } };
      onTime: (ms: number) => void;
      onPlayingChange: (p: boolean) => void;
    },
    playing: false,
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
  },
}));

vi.mock("@/components/media", async (orig) => {
  const actual = await orig<typeof import("@/components/media")>();
  const React = await import("react");
  return {
    ...actual,
    MediaPlayer: React.forwardRef(function MediaPlayerStub(p: NonNullable<typeof h.player.props>, ref: React.Ref<unknown>) {
      h.player.props = p;
      React.useImperativeHandle(ref, () => ({
        play() {
          h.player.play();
          h.player.playing = true;
          p.onPlayingChange(true);
        },
        pause() {
          h.player.pause();
          h.player.playing = false;
          p.onPlayingChange(false);
        },
        toggle() {},
        seek(ms: number) {
          h.player.seek(ms);
          p.onTime(ms);
        },
        step() {},
        currentMs: () => 0,
        playing: () => h.player.playing,
      }));
      return <audio data-testid="audio" />;
    }),
  };
});

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
import { useEditStudio } from "@/editor/store";
import { getPlayer } from "./player";
import { Transport } from "./Transport";

const source = { url: "/media/t/song.mp3", proxy: false, proxyJobId: "", info: { durationMs: 200_000, startMs: 0, container: "mp3", sizeBytes: 1, bitRate: 0, audio: [], subtitles: [], hasCover: false } };

function openEdit(startMs = 10_000, endMs = 30_000): void {
  const doc = emptyEditProject("9:16", 30, 1) as NormalProject;
  doc.song = { path: "/song.mp3", startMs, endMs, gainDb: 0, fadeInMs: 0, fadeOutMs: 500 };
  useEditStudio.getState().open("p1", "Edit", doc);
}
const project = () => useEditStudio.getState().history!.present;
const audio = () => screen.getByTestId("audio") as HTMLAudioElement;

beforeEach(() => {
  h.open.mockReset();
  h.probe.mockReset();
  h.pickWith.mockReset();
  h.open.mockResolvedValue(source);
  Object.assign(h.player, { props: null, playing: false });
  h.player.play.mockReset();
  h.player.pause.mockReset();
  h.player.seek.mockReset();
  useEditStudio.getState().close();
});
afterEach(cleanup);

describe("Transport", () => {
  it("shows the time, and gives the player the song's range as its clock", async () => {
    openEdit(10_000, 30_000);
    render(<Transport />);
    expect(screen.getByLabelText("Time").textContent).toBe("0:00.000 / 0:20.000");
    await waitFor(() => expect(h.player.props).toBeTruthy());
    expect(h.player.props?.source.info).toMatchObject({ startMs: 10_000, durationMs: 20_000 });
  });

  it("plays and pauses through the player; the store follows", async () => {
    openEdit();
    render(<Transport />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(h.player.play).toHaveBeenCalled();
    expect(useEditStudio.getState().playing).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(h.player.pause).toHaveBeenCalled();
    expect(useEditStudio.getState().playing).toBe(false);
  });

  it("registers a controller for the shortcuts", async () => {
    openEdit();
    const { unmount } = render(<Transport />);
    await waitFor(() => expect(getPlayer()).toBeTruthy());
    getPlayer()?.seek(4000);
    expect(useEditStudio.getState().playheadMs).toBe(4000);
    unmount();
    expect(getPlayer()).toBeNull();
  });

  it("onTime moves the playhead and applies gain and fades to the volume", async () => {
    openEdit();
    render(<Transport />);
    await waitFor(() => expect(h.player.props).toBeTruthy());
    act(() => h.player.props?.onTime(5000));
    expect(useEditStudio.getState().playheadMs).toBe(5000);
    expect(audio().volume).toBe(1);
    act(() => h.player.props?.onTime(19_750));
    expect(audio().volume).toBeCloseTo(0.5);
  });

  it("stops at the end of the edit", async () => {
    openEdit();
    render(<Transport />);
    await waitFor(() => expect(h.player.props).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Play" }));
    act(() => h.player.props?.onTime(20_000));
    expect(h.player.pause).toHaveBeenCalled();
    expect(useEditStudio.getState().playheadMs).toBe(20_000);
    expect(useEditStudio.getState().playing).toBe(false);
  });

  it("seeks the audio when the playhead is moved from outside, not for its own ticks", async () => {
    openEdit();
    render(<Transport />);
    await waitFor(() => expect(h.player.props).toBeTruthy());
    h.player.seek.mockClear();
    act(() => h.player.props?.onTime(1000));
    expect(h.player.seek).not.toHaveBeenCalled();
    act(() => useEditStudio.getState().setPlayhead(7000));
    expect(h.player.seek).toHaveBeenCalledWith(7000);
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

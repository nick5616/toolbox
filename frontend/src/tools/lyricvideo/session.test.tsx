import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  state: {} as Record<string, string>,
  stat: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    SettingsService: {
      ModuleState: async (k: string) => h.state[k] ?? "",
      SetModuleState: (k: string, v: string) => {
        h.set(k, v);
        h.state[k] = v;
        return Promise.resolve();
      },
    },
    FilesService: { Stat: (...a: unknown[]) => h.stat(...a), Pick: async () => [], PickWith: async () => [] },
    LyricVideoService: { Fonts: async () => ["Arial"], Enqueue: async () => [] },
  };
});

vi.mock("./LyricVideoWorkspace", () => ({ default: () => <div data-testid="workspace" /> }));

import { setCurrentWindowForTest, parseWindow } from "@/lib/windows";
import { useUI } from "@/state/ui";
import { SESSION_KEY, resetRestoreForTest, serializeSession, MAX_SESSION_BYTES, type Session } from "./session";
import { resetLyricVideo, useLyricVideo } from "./store";
import LyricVideoView from "./LyricVideoView";

const SESSION: Session = {
  songPath: "C:/music/night-drive.mp3",
  meta: { title: "Night Drive", artist: "Owl" },
  text: "la la la",
  lyricsPath: "",
  rows: [
    { id: "l1", startMs: 1000, endMs: 3000, text: "Hello there", words: [] },
    { id: "l2", startMs: 3500, endMs: 6000, text: "Edited line", words: [] },
  ],
  matched: 2,
  noLyrics: false,
  hasInstrumental: true,
};

const exists = (ok: boolean) => h.stat.mockResolvedValue([{ path: SESSION.songPath, name: "n", sizeBytes: 1, exists: ok, isDir: false, kind: "audio" }]);

beforeEach(() => {
  h.state = {};
  h.stat.mockReset();
  h.set.mockClear();
  resetLyricVideo();
  resetRestoreForTest();
  useUI.setState({ handoff: null });
  exists(true);
});

afterEach(() => {
  cleanup();
  setCurrentWindowForTest(null);
});

describe("Lyric Video reopens where you left off", () => {
  it("restores the session when the song still exists (StrictMode-safe)", async () => {
    h.state[SESSION_KEY] = JSON.stringify(SESSION);
    render(
      <StrictMode>
        <LyricVideoView moduleId="lyric-video" />
      </StrictMode>,
    );
    expect(await screen.findByTestId("workspace")).toBeTruthy();
    const s = useLyricVideo.getState();
    expect(s.songPath).toBe(SESSION.songPath);
    expect(s.meta).toEqual(SESSION.meta);
    expect(s.text).toBe("la la la");
    expect(s.rows.map((r) => [r.startMs, r.text])).toEqual([
      [1000, "Hello there"],
      [3500, "Edited line"],
    ]);
    expect(s.matched).toBe(2);
    expect(s.visualsEngaged).toBe(false);
    expect(h.stat).toHaveBeenCalledTimes(1);
  });

  it("drops a session whose song is gone", async () => {
    h.state[SESSION_KEY] = JSON.stringify(SESSION);
    exists(false);
    render(<LyricVideoView moduleId="lyric-video" />);
    await waitFor(() => expect(h.set).toHaveBeenCalledWith(SESSION_KEY, ""));
    expect(useLyricVideo.getState().songPath).toBeNull();
    expect(screen.getByText("Drop a song")).toBeTruthy();
  });

  it("a handoff wins over the restore and replaces the record", async () => {
    h.state[SESSION_KEY] = JSON.stringify(SESSION);
    useUI.setState({ handoff: { moduleId: "lyric-video", inputs: ["C:/other/new.mp3"] } } as never);
    render(<LyricVideoView moduleId="lyric-video" />);
    await waitFor(() => expect(useLyricVideo.getState().songPath).toBe("C:/other/new.mp3"));
    expect(useLyricVideo.getState().rows).toHaveLength(0);
    await waitFor(() => expect((JSON.parse(h.state[SESSION_KEY]!) as Session).songPath).toBe("C:/other/new.mp3"), { timeout: 3000 });
  });

  it("a replica neither restores nor saves", async () => {
    h.state[SESSION_KEY] = JSON.stringify(SESSION);
    setCurrentWindowForTest(parseWindow("?window=part&part=lyric-video.preview&key=part:lyric-video.preview"));
    useLyricVideo.setState({ songPath: "C:/music/live.mp3" });
    render(<LyricVideoView moduleId="lyric-video" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });
    expect(h.stat).not.toHaveBeenCalled();
    expect(useLyricVideo.getState().songPath).toBe("C:/music/live.mp3");
    expect(h.set.mock.calls.filter(([k]) => k === SESSION_KEY)).toHaveLength(0);
  });

  it("saves the session, debounced", async () => {
    useLyricVideo.getState().applySong("C:/music/a.mp3");
    render(<LyricVideoView moduleId="lyric-video" />);
    await waitFor(() => expect(h.set).toHaveBeenCalledWith(SESSION_KEY, expect.any(String)), { timeout: 3000 });
    expect((JSON.parse(h.state[SESSION_KEY]!) as Session).songPath).toBe("C:/music/a.mp3");
  });
});

describe("serializeSession", () => {
  it("stays within the cap: drops word timings, then the lines", () => {
    const words = Array.from({ length: 4000 }, (_, i) => ({ startMs: i, endMs: i + 1, text: "word" }));
    const big: Session = { ...SESSION, rows: [{ id: "l1", startMs: 0, endMs: 1, text: "x", words: words as never }] };
    const json = serializeSession(big)!;
    expect(json.length).toBeLessThanOrEqual(MAX_SESSION_BYTES);
    expect((JSON.parse(json) as Session).rows[0]!.words).toEqual([]);
    const huge: Session = { ...SESSION, rows: Array.from({ length: 5000 }, (_, i) => ({ id: `l${i}`, startMs: i, endMs: i + 1, text: "a long lyric line to fill the space", words: [] })) };
    const j2 = serializeSession(huge)!;
    expect(j2.length).toBeLessThanOrEqual(MAX_SESSION_BYTES);
    expect((JSON.parse(j2) as Session).rows).toEqual([]);
    expect(serializeSession(null)).toBeNull();
  });
});

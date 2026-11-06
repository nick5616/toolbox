import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => new Map<string, string>());
const existing = vi.hoisted(() => new Set<string>());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FilesService: {
      Stat: async (paths: string[]) => paths.map((p) => ({ path: p, name: p, sizeBytes: 1, exists: existing.has(p), isDir: false, kind: "video" })),
    },
    SettingsService: {
      ModuleState: async (k: string) => saved.get(k) ?? "",
      SetModuleState: async (k: string, v: string) => {
        saved.set(k, v);
      },
    },
  };
});

import { makeTab } from "./editor";
import { toRows } from "./logic";
import { parseWindow, setCurrentWindowForTest } from "@/lib/windows";
import { useUI } from "@/state/ui";
import {
  LAST_SAVE_DEBOUNCE_MS,
  LAST_SESSION_KEY,
  MAX_LAST_SESSION_BYTES,
  SESSION_KEY,
  resetLastSessionForTest,
  restoreLastSession,
  restoreSession,
  saveLastSession,
  saveSession,
  useSessionTransfer,
} from "./session";
import { activeRows, initialData, useSubtitles } from "./store";

const s = () => useSubtitles.getState();

function openWork() {
  useSubtitles.setState({
    mediaPath: "/in/talk.mp4",
    subPath: "/in/talk.srt",
    editor: { tabs: [makeTab("original", "Original", "en", toRows([{ startMs: 0, endMs: 1000, text: "Hello" }]))], activeId: "original" },
  });
  s().patchCue(activeRows(s())[0]!.id, { text: "Edited" });
}

describe("popping the whole tool out keeps the session", () => {
  beforeEach(() => {
    saved.clear();
    useSubtitles.setState(initialData());
  });

  it("parks unsaved cues with their history and restores them once", async () => {
    openWork();
    await saveSession(1000);
    expect(saved.get(SESSION_KEY)).toBeTruthy();

    useSubtitles.setState(initialData()); // the new window's empty store
    expect(await restoreSession(2000)).toBe(true);
    expect(s().mediaPath).toBe("/in/talk.mp4");
    expect(s().subPath).toBe("/in/talk.srt");
    expect(activeRows(s())[0]?.text).toBe("Edited");
    s().undo(); // the undo history came along
    expect(activeRows(s())[0]?.text).toBe("Hello");
    expect(saved.get(SESSION_KEY)).toBe(""); // cleared

    useSubtitles.setState(initialData());
    expect(await restoreSession(2500)).toBe(false); // only once
  });

  it("saves nothing without a session, ignores stale or garbled ones, and never overwrites handed-over work", async () => {
    await saveSession();
    expect(saved.has(SESSION_KEY)).toBe(false);

    openWork();
    await saveSession(1000);
    useSubtitles.setState(initialData());
    expect(await restoreSession(1000 + 61_000)).toBe(false);

    saved.set(SESSION_KEY, "{nope");
    expect(await restoreSession()).toBe(false);

    openWork();
    await saveSession(5000);
    useSubtitles.setState({ ...initialData(), mediaPath: "/in/other.mp4" });
    expect(await restoreSession(5100)).toBe(false);
    expect(s().mediaPath).toBe("/in/other.mp4");
  });
});

describe("reopening after a restart", () => {
  beforeEach(() => {
    saved.clear();
    existing.clear();
    resetLastSessionForTest();
    useSubtitles.setState(initialData());
    useUI.setState({ handoff: null });
  });
  afterEach(() => {
    vi.useRealTimers();
    setCurrentWindowForTest(null);
  });

  it("restores the cues, edits, selection and playhead when the media file still exists", async () => {
    openWork();
    const id = activeRows(s())[0]!.id;
    useSubtitles.setState({ selectedId: id, playheadMs: 420 });
    await saveLastSession();
    useSubtitles.setState(initialData());
    existing.add("/in/talk.mp4");

    expect(await restoreLastSession()).toBe(true);
    expect(s().mediaPath).toBe("/in/talk.mp4");
    expect(activeRows(s())[0]?.text).toBe("Edited");
    expect(s().selectedId).toBe(id);
    expect(s().playheadMs).toBe(420);
    expect(s().editor.tabs[0]?.history.past).toHaveLength(0); // no undo history is kept
    expect(saved.get(LAST_SESSION_KEY)).toBeTruthy();
  });

  it("starts empty and drops the record when the file is gone", async () => {
    openWork();
    await saveLastSession();
    useSubtitles.setState(initialData());
    expect(await restoreLastSession()).toBe(false);
    expect(s().mediaPath).toBeNull();
    expect(saved.get(LAST_SESSION_KEY)).toBe("");
  });

  it("lets a handoff win over the restore", async () => {
    openWork();
    await saveLastSession();
    useSubtitles.setState(initialData());
    existing.add("/in/talk.mp4");

    useUI.setState({ handoff: { moduleId: "subtitles", inputs: ["/in/new.mp4"] } as never });
    expect(await restoreLastSession()).toBe(false);

    useUI.setState({ handoff: null });
    useSubtitles.setState({ mediaPath: "/in/new.mp4" }); // the handoff already opened a file
    expect(await restoreLastSession()).toBe(false);
    expect(s().mediaPath).toBe("/in/new.mp4");
  });

  it("skips saving above the size cap", async () => {
    openWork();
    const big = "x".repeat(MAX_LAST_SESSION_BYTES);
    useSubtitles.getState().patchCue(activeRows(s())[0]!.id, { text: big });
    await saveLastSession();
    expect(saved.get(LAST_SESSION_KEY)).toBe("");
  });

  it("the main window saves on change (debounced) and a replica neither restores nor saves", async () => {
    vi.useFakeTimers();
    existing.add("/in/talk.mp4");
    setCurrentWindowForTest(parseWindow(""));
    const main = renderHook(() => useSessionTransfer());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    openWork();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LAST_SAVE_DEBOUNCE_MS + 10);
    });
    expect(JSON.parse(saved.get(LAST_SESSION_KEY) ?? "null")?.mediaPath).toBe("/in/talk.mp4");
    main.unmount();

    // A replica: part window.
    saved.clear();
    resetLastSessionForTest();
    useSubtitles.setState(initialData());
    saved.set(LAST_SESSION_KEY, JSON.stringify({ v: 1, mediaPath: "/in/talk.mp4", subPath: null, tabs: [], activeId: "", selectedId: "", sourceLang: null, chosen: null, addVisuals: false, playheadMs: 0 }));
    setCurrentWindowForTest(parseWindow("?window=part&part=subtitles.panel&panel=cues&key=part:subtitles.panel@cues"));
    const replica = renderHook(() => useSessionTransfer());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(s().mediaPath).toBeNull(); // nothing restored
    openWork();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LAST_SAVE_DEBOUNCE_MS + 10);
    });
    expect(JSON.parse(saved.get(LAST_SESSION_KEY) ?? "null")?.tabs).toEqual([]); // nothing saved
    replica.unmount();
  });
});

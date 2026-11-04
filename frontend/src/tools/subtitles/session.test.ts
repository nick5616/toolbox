import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => new Map<string, string>());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
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
import { SESSION_KEY, restoreSession, saveSession } from "./session";
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

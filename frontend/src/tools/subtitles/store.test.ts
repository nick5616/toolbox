import { beforeEach, describe, expect, it, vi } from "vitest";

const load = vi.hoisted(() => vi.fn());
const enqueue = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    SubtitlesService: { Load: (...a: unknown[]) => load(...a), Enqueue: (...a: unknown[]) => enqueue(...a) },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
  };
});

import { JobStatus, type Job } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { makeTab } from "./editor";
import { toRows } from "./logic";
import { activeBlocker, activeRows, initialData, useSubtitles } from "./store";

const CUES = [
  { startMs: 0, endMs: 2000, text: "Hello" },
  { startMs: 2500, endMs: 4000, text: "World" },
];

function withCues() {
  useSubtitles.setState({ editor: { tabs: [makeTab("original", "Original", "en", toRows(CUES))], activeId: "original" } });
}

const s = () => useSubtitles.getState();

describe("Subtitles store", () => {
  beforeEach(() => {
    useSubtitles.setState(initialData());
    useJobs.setState({ byId: {} });
    load.mockReset();
    enqueue.mockReset();
  });

  it("edits a cue and undoes and redoes it", () => {
    withCues();
    const id = activeRows(s())[0]!.id;
    s().patchCue(id, { text: "Hi" });
    expect(activeRows(s())[0]?.text).toBe("Hi");
    s().undo();
    expect(activeRows(s())[0]?.text).toBe("Hello");
    s().redo();
    expect(activeRows(s())[0]?.text).toBe("Hi");
  });

  it("inserts, merges and shifts through the row actions", () => {
    withCues();
    const first = activeRows(s())[0]!.id;
    s().rowAction("insert", first, -1);
    expect(activeRows(s())).toHaveLength(3);
    expect(s().focusId).toBe(activeRows(s())[1]?.id);
    s().shift(1000);
    expect(activeRows(s())[0]?.startMs).toBe(1000);
    s().rowAction("merge", first, -1);
    expect(activeRows(s()).length).toBeLessThan(3);
  });

  it("replaces text everywhere in one undoable step", () => {
    withCues();
    s().replaceAll("o", "0", false);
    expect(activeRows(s()).map((r) => r.text)).toEqual(["Hell0", "W0rld"]);
    s().undo();
    expect(activeRows(s()).map((r) => r.text)).toEqual(["Hello", "World"]);
  });

  it("routes dropped files to the media or to the subtitles", async () => {
    load.mockResolvedValue(CUES);
    s().handleInputs(["/in/talk.mp4"]);
    expect(s().mediaPath).toBe("/in/talk.mp4");
    s().handleInputs(["/in/talk.srt"]);
    await vi.waitFor(() => expect(s().editor.tabs).toHaveLength(1));
    expect(s().subPath).toBe("/in/talk.srt");
    expect(s().editor.tabs[0]?.history.present).toHaveLength(2);
  });

  it("asks before dropping unsaved edits, and carries on once confirmed", async () => {
    load.mockResolvedValue(CUES);
    withCues();
    s().patchCue(activeRows(s())[0]!.id, { text: "Changed" });
    s().openSubtitleFile("/in/other.srt");
    expect(s().pendingConfirm?.then).toEqual({ kind: "subtitleFile", path: "/in/other.srt" });
    expect(load).not.toHaveBeenCalled();
    s().confirmPending();
    expect(s().pendingConfirm).toBeNull();
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith("/in/other.srt"));
    s().openSubtitleFile("/in/x.srt"); // fresh load: no longer dirty
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("a cut replaces the source and clears the cues only after confirming", () => {
    s().takeMedia("/in/a.mp4");
    withCues();
    s().useCut(["/in/cut.mp4"]);
    expect(s().mediaPath).toBe("/in/a.mp4");
    expect(s().pendingConfirm?.then).toEqual({ kind: "useCut", path: "/in/cut.mp4" });
    s().cancelPending();
    expect(s().mediaPath).toBe("/in/a.mp4");
    s().useCut(["/in/cut.mp4"]);
    s().confirmPending();
    expect(s().mediaPath).toBe("/in/cut.mp4");
    expect(s().editor.tabs).toHaveLength(0);
    // Without cues there is nothing to confirm.
    s().useCut(["/in/cut2.mp4"]);
    expect(s().pendingConfirm).toBeNull();
    expect(s().mediaPath).toBe("/in/cut2.mp4");
  });

  it("player commands carry a counter so every window runs each once", () => {
    const n0 = s().cmd.n;
    s().seek(1500);
    expect(s().playheadMs).toBe(1500);
    expect(s().cmd).toEqual({ n: n0 + 1, type: "seek", ms: 1500 });
    s().play();
    expect(s().cmd.type).toBe("play");
    s().reportTime(1600);
    expect(s().cmd.n).toBe(n0 + 2); // a report is not a command
    expect(s().playheadMs).toBe(1600);
  });

  it("blocks export while a cue is invalid", () => {
    withCues();
    expect(activeBlocker(s())).toBeNull();
    s().patchCue(activeRows(s())[1]!.id, { text: "" });
    expect(activeBlocker(s())).toContain("empty");
  });

  it("starts a generate job with the prefs and follows it", async () => {
    s().takeMedia("/in/talk.mp4");
    s().patchPrefs({ model: "turbo" });
    enqueue.mockResolvedValue([{ id: "g1" } as Job]);
    s().generate();
    await vi.waitFor(() => expect(s().runs.gen.jobId).toBe("g1"));
    const [inputs, opts] = enqueue.mock.calls[0] as [string[], { action: string; model: string }];
    expect(inputs).toEqual(["/in/talk.mp4"]);
    expect(opts).toMatchObject({ action: "generate", model: "turbo" });
    useJobs.setState({ byId: { g1: { id: "g1", status: JobStatus.JobRunning } as never } });
    s().clearRun("gen");
    expect(s().runs.gen.jobId).toBe("");
  });
});

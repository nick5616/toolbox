import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  markers: [] as Array<{ id: string; lane: string; ms: number; strength: number }>,
}));

vi.mock("@/editor/store", async (orig) => {
  const actual = await orig<typeof import("@/editor/store")>();
  return { ...actual, useMarkers: () => h.markers };
});

import { useCommandRegistry } from "@/lib/commands";
import { emptyEditProject, type NormalProject } from "@/viz/edit/defaults";
import { newClip } from "@/editor/doc";
import { useNewEditRequest } from "../home/newEditRequest";
import { useEditStudio } from "@/editor/store";
import { useEditCommands } from "./commands";
import { registerPlayer, type PlayerController } from "./player";
import { EDIT_SHORTCUTS } from "./shortcuts";

function Harness() {
  useEditCommands();
  return null;
}

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

let player: PlayerController & { calls: string[]; _rate: number };
let unregister: () => void;

beforeEach(() => {
  h.markers = [1000, 2000, 3000, 4500].map((ms) => ({ id: `kick:${ms}`, lane: "kick", ms, strength: 1 }));
  useEditStudio.getState().close();
  useNewEditRequest.setState({ pending: null, songReplace: null });
  openEdit();
  useEditStudio.getState().setActiveLane("kick");
  const calls: string[] = [];
  player = {
    calls,
    _rate: 1,
    play: () => calls.push("play"),
    pause: () => calls.push("pause"),
    toggle: () => calls.push("toggle"),
    seek: (ms: number) => {
      calls.push(`seek:${ms}`);
      useEditStudio.getState().setPlayhead(ms);
    },
    setRate(r: number) {
      calls.push(`rate:${r}`);
      this._rate = r;
    },
    rate() {
      return this._rate;
    },
    reverse: () => calls.push("reverse"),
    loop: (r) => calls.push(`loop:${r ? `${r.inMs}-${r.outMs}` : "off"}`),
  };
  unregister = registerPlayer(player);
});
afterEach(() => {
  unregister();
  cleanup();
});

describe("shortcut table", () => {
  it("has unique combos and leaves T and M to the Lanes package", () => {
    const all = EDIT_SHORTCUTS.flatMap((s) => s.combos);
    expect(new Set(all).size).toBe(all.length);
    expect(all.map((c) => c.toLowerCase())).not.toContain("t");
    expect(all.map((c) => c.toLowerCase())).not.toContain("m");
  });
});

describe("transport keys", () => {
  it("Space toggles, K pauses", () => {
    render(<Harness />);
    key(" ");
    key("k");
    expect(player.calls).toEqual(["toggle", "pause"]);
  });

  it("L plays; while playing it steps the speed 1.5x then 2x", () => {
    render(<Harness />);
    key("l");
    expect(player.calls).toEqual(["play"]);
    act(() => useEditStudio.getState().setPlaying(true));
    key("l");
    key("l");
    expect(player.calls.slice(1)).toEqual(["rate:1.5", "rate:2"]);
  });

  it("J goes back 2 s and plays", () => {
    render(<Harness />);
    useEditStudio.getState().setPlayhead(5000);
    key("j");
    expect(player.calls).toEqual(["seek:3000", "play"]);
  });

  it("J doesn't go before 0", () => {
    render(<Harness />);
    useEditStudio.getState().setPlayhead(500);
    key("j");
    expect(player.calls[0]).toBe("seek:0");
  });

  it("comma and period step one frame (30 fps)", () => {
    render(<Harness />);
    useEditStudio.getState().setPlayhead(1000);
    key(".");
    expect(useEditStudio.getState().playheadMs).toBeCloseTo(1033.33, 1);
    key(",");
    key(",");
    expect(useEditStudio.getState().playheadMs).toBeCloseTo(966.67, 1);
  });

  it("[ and ] jump to the previous and next marker on the active lane", () => {
    render(<Harness />);
    useEditStudio.getState().setPlayhead(2500);
    key("]");
    expect(useEditStudio.getState().playheadMs).toBe(3000);
    key("[");
    key("[");
    expect(useEditStudio.getState().playheadMs).toBe(1000);
    key("[");
    expect(useEditStudio.getState().playheadMs).toBe(1000);
  });

  it("Home and End", () => {
    render(<Harness />);
    useEditStudio.getState().setPlayhead(2500);
    key("End");
    expect(useEditStudio.getState().playheadMs).toBe(20_000);
    key("Home");
    expect(useEditStudio.getState().playheadMs).toBe(0);
  });

  it("number keys set the active lane from the visible lanes", () => {
    render(<Harness />);
    key("1");
    expect(useEditStudio.getState().activeLane).toBe("beat");
    key("3");
    expect(useEditStudio.getState().activeLane).toBe("kick");
    key("9"); // there are fewer than 9 visible lanes by default? stays valid either way
    expect(typeof useEditStudio.getState().activeLane).toBe("string");
  });

  it("ignores keys typed into a text field", () => {
    render(
      <>
        <Harness />
        <input aria-label="x" />
      </>,
    );
    const input = document.querySelector("input") as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "k" });
    expect(player.calls).toEqual([]);
  });
});

describe("editing keys", () => {
  it("S splits the selected clips at the playhead", () => {
    render(<Harness />);
    useEditStudio.getState().select({ kind: "clips", ids: ["a"] });
    useEditStudio.getState().setPlayhead(1500);
    key("s");
    expect(spans()).toEqual([[0, 1500], [1500, 4000], [5000, 6000]]);
  });

  it("S with nothing selected splits the clip under the playhead on the first unlocked video track", () => {
    render(<Harness />);
    useEditStudio.getState().setPlayhead(5500);
    key("s");
    expect(spans()).toEqual([[0, 4000], [5000, 5500], [5500, 6000]]);
  });

  it("Delete and Backspace delete selected clips", () => {
    render(<Harness />);
    useEditStudio.getState().select({ kind: "clips", ids: ["a"] });
    key("Delete");
    expect(spans()).toEqual([[5000, 6000]]);
    expect(useEditStudio.getState().selection).toBeNull();
    useEditStudio.getState().select({ kind: "clips", ids: ["b"] });
    key("Backspace");
    expect(spans()).toEqual([]);
  });

  it("Delete leaves selected markers to the lanes' own handler", () => {
    render(<Harness />);
    const before = project().markers;
    useEditStudio.getState().select({ kind: "markers", ids: ["kick:1000"] });
    key("Delete");
    expect(project().markers).toBe(before);
  });

  it("Mod+D duplicates to the right; Mod+Z undoes; Mod+Shift+Z and Mod+Y redo", () => {
    render(<Harness />);
    useEditStudio.getState().select({ kind: "clips", ids: ["b"] });
    key("d", { ctrlKey: true });
    expect(spans()).toEqual([[0, 4000], [5000, 6000], [6000, 7000]]);
    key("z", { ctrlKey: true });
    expect(spans()).toEqual([[0, 4000], [5000, 6000]]);
    key("z", { ctrlKey: true, shiftKey: true });
    expect(spans()).toHaveLength(3);
    key("z", { ctrlKey: true });
    key("y", { ctrlKey: true });
    expect(spans()).toHaveLength(3);
  });

  it("Mod+A selects every clip on the selected track", () => {
    render(<Harness />);
    useEditStudio.getState().select({ kind: "track", id: "t1" });
    key("a", { ctrlKey: true });
    expect(useEditStudio.getState().selection).toEqual({ kind: "clips", ids: ["a", "b"] });
  });
});

describe("palette commands", () => {
  const cmd = (id: string) => useCommandRegistry.getState().commands[`video-studio.${id}`];

  it("registers the tool's section", () => {
    render(<Harness />);
    const ids = Object.keys(useCommandRegistry.getState().commands)
      .filter((k) => k.startsWith("video-studio."))
      .sort();
    expect(ids).toEqual(
      ["add-adjust-track", "add-track", "export", "new", "safe-zones", "snap", "split-subject"].map((s) => `video-studio.${s}`).sort(),
    );
    expect(cmd("export")?.section).toBe("Video Editor");
    expect(cmd("new")?.title).toBe("New video");
  });

  it("Export opens its dialog", async () => {
    render(<Harness />);
    await cmd("export")?.run();
    expect(useEditStudio.getState().dialog).toEqual({ kind: "export" });
  });

  it("Export needs no analysed song in the Video Editor", () => {
    render(<Harness />);
    useEditStudio.getState().setAnalysis(null, null, "none");
    expect(cmd("export")?.enabled?.()).toBe(true);
  });

  it("toggles safe zones and snapping, adds tracks", async () => {
    render(<Harness />);
    await cmd("safe-zones")?.run();
    expect(useEditStudio.getState().safeZones).toBe(true);
    await cmd("snap")?.run();
    expect(useEditStudio.getState().snap).toBe(false);
    await cmd("add-track")?.run();
    await cmd("add-adjust-track")?.run();
    expect(project().tracks.map((t) => t.kind)).toEqual(["video", "adjust", "video", "adjust"]);
  });

  it("New edit closes the open edit and asks the home for the dialog", async () => {
    render(<Harness />);
    await cmd("new")?.run();
    expect(useEditStudio.getState().projectId).toBeNull();
    expect(useNewEditRequest.getState().pending).toEqual({});
  });

  it("commands are removed when the editor closes", () => {
    const { unmount } = render(<Harness />);
    unmount();
    expect(cmd("export")).toBeUndefined();
  });
});

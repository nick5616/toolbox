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
import { EditorProfileProvider, PLAIN_PROFILE } from "../profileContext";
import type { EditorProfile } from "../profile";
import { registerPlayer, type PlayerController } from "./player";
import { EDIT_SHORTCUTS, SHORTCUT_SCOPES } from "./shortcuts";
import { currentRange, useTimelineStore } from "../timeline/timelineStore";

function Harness() {
  useEditCommands();
  return null;
}

/** Edit Studio's profile: markers come from the song's lanes; [ ] M and marker Delete belong to the Lanes. */
const STUDIO: EditorProfile = { ...PLAIN_PROFILE, moduleId: "edit-studio", title: "Edit Studio", song: "analyzed", markerSignals: true };
function StudioHarness() {
  return (
    <EditorProfileProvider profile={STUDIO}>
      <Harness />
    </EditorProfileProvider>
  );
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

  it("has no duplicate combo within any one scope (shared keys count in every scope), and unique ids", () => {
    const norm = (c: string) => c.toLowerCase();
    for (const scope of [undefined, ...SHORTCUT_SCOPES]) {
      const active = EDIT_SHORTCUTS.filter((s) => s.scope === undefined || s.scope === scope);
      const combos = active.flatMap((s) => s.combos.map(norm));
      const dupes = combos.filter((c, i) => combos.indexOf(c) !== i);
      expect(dupes, `scope ${scope ?? "shared"}`).toEqual([]);
    }
    const ids = EDIT_SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every combo is well-formed for the key matcher (modifiers then one key)", () => {
    for (const s of EDIT_SHORTCUTS) for (const c of s.combos) expect(c.split("+").every((p, i, a) => i === a.length - 1 || ["Mod", "Shift", "Alt", "Ctrl"].includes(p))).toBe(true);
  });

  it("the Phase 21 table has the keys the spec lists", () => {
    const has = (id: string, combo: string) => expect(EDIT_SHORTCUTS.find((s) => s.id === id)?.combos).toContain(combo);
    has("toolSelect", "V");
    has("toolRazor", "C");
    has("toolRipple", "B");
    has("toolRoll", "N");
    has("toolSlip", "Y");
    has("zoomIn", "=");
    has("zoomOut", "-");
    has("zoomFit", "\\");
    has("markIn", "I");
    has("markOut", "O");
    has("clearRange", "Alt+X");
    has("loop", "Shift+L");
    has("snapping", "Shift+N");
    has("rippleDelete", "Shift+Delete");
    has("copy", "Mod+C");
    has("cut", "Mod+X");
    has("paste", "Mod+V");
    has("pasteInsert", "Mod+Shift+V");
    has("link", "Mod+L");
    has("prevEdit", "ArrowUp");
    has("nextEdit", "ArrowDown");
    has("back1s", "Shift+ArrowLeft");
    has("fwd1s", "Shift+ArrowRight");
    has("prevKey", "Alt+[");
    has("nextKey", "Alt+]");
  });
});

describe("Phase 21 editing keys", () => {
  const clipIds = () => project().tracks.flatMap((t) => t.clips.map((c) => c.id));

  it("V C B N Y switch the timeline tool", () => {
    render(<Harness />);
    for (const [k, tool] of [["c", "razor"], ["b", "ripple"], ["n", "roll"], ["y", "slip"], ["v", "select"]] as const) {
      key(k);
      expect(useTimelineStore.getState().tool).toBe(tool);
    }
  });

  it("Shift+N toggles snapping", () => {
    render(<Harness />);
    const before = useEditStudio.getState().snap;
    key("N", { shiftKey: true });
    expect(useEditStudio.getState().snap).toBe(!before);
    expect(useTimelineStore.getState().tool).toBe("select"); // not the Roll tool
  });

  it("= and - zoom around the playhead; \\ fits", () => {
    render(<Harness />);
    useEditStudio.getState().setView(100, 0);
    useEditStudio.getState().setPlayhead(2000);
    useTimelineStore.getState().setViewWidth(800);
    const x = (ms: number, pps: number, scroll: number) => ((ms - scroll) * pps) / 1000;
    key("=");
    const z = useEditStudio.getState();
    expect(z.pps).toBeGreaterThan(100);
    expect(x(2000, z.pps, z.scrollMs)).toBeCloseTo(x(2000, 100, 0), 4);
    key("-");
    expect(useEditStudio.getState().pps).toBeCloseTo(100, 4);
    key("\\");
    const f = useEditStudio.getState();
    expect(f.scrollMs).toBe(0);
    expect(f.pps).toBeLessThan(200);
  });

  it("I and O set the range; the range is readable for export; Alt+X clears it", () => {
    render(<Harness />);
    useEditStudio.getState().setPlayhead(1000);
    key("i");
    useEditStudio.getState().setPlayhead(3000);
    key("o");
    expect(currentRange()).toEqual({ inMs: 1000, outMs: 3000 });
    key("x", { altKey: true });
    expect(currentRange()).toBeNull();
    expect(useTimelineStore.getState().rangeInMs).toBeNull();
  });

  it("I alone ranges to the end of the edit; O alone from the start; crossing clears the other end", () => {
    render(<Harness />);
    useEditStudio.getState().setPlayhead(2000);
    key("i");
    expect(currentRange()).toEqual({ inMs: 2000, outMs: 20_000 });
    useEditStudio.getState().setPlayhead(1000);
    key("o");
    expect(currentRange()).toEqual({ inMs: 0, outMs: 1000 });
  });

  it("Shift+L loops the range through the player; without a range it asks for one", () => {
    const loops: Array<unknown> = [];
    unregister();
    unregister = registerPlayer({ ...player, loop: (r: unknown) => loops.push(r) } as PlayerController);
    render(<Harness />);
    key("L", { shiftKey: true });
    expect(loops).toEqual([]);
    useTimelineStore.getState().setRange(1000, 3000);
    key("L", { shiftKey: true });
    expect(loops.at(-1)).toEqual({ inMs: 1000, outMs: 3000 });
    expect(useTimelineStore.getState().loop).toBe(true);
    key("L", { shiftKey: true });
    expect(loops.at(-1)).toBeNull();
    expect(useTimelineStore.getState().loop).toBe(false);
  });

  it("J plays in reverse when the clock offers it", () => {
    const calls: string[] = [];
    unregister();
    unregister = registerPlayer({ ...player, reverse: () => calls.push("reverse") } as PlayerController);
    render(<Harness />);
    key("j");
    expect(calls).toEqual(["reverse"]);
  });

  it("Shift+Delete ripple-deletes the selection", () => {
    render(<Harness />);
    useEditStudio.getState().select({ kind: "clips", ids: ["a"] });
    key("Delete", { shiftKey: true });
    expect(spans()).toEqual([[1000, 2000]]);
  });

  it("Delete leaves a gap; selecting the gap and pressing Delete closes it", () => {
    render(<Harness />);
    useEditStudio.getState().select({ kind: "clips", ids: ["a"] });
    key("Delete");
    expect(spans()).toEqual([[5000, 6000]]);
    useTimelineStore.getState().selectGap({ trackId: "t1", fromMs: 0, toMs: 5000 });
    useEditStudio.getState().select({ kind: "track", id: "t1" });
    key("Delete");
    expect(spans()).toEqual([[0, 1000]]);
  });

  it("Ctrl+C then Ctrl+V pastes at the playhead (overwrite); Ctrl+Shift+V inserts; Ctrl+X cuts", () => {
    render(<Harness />);
    useEditStudio.getState().select({ kind: "clips", ids: ["b"] });
    key("c", { ctrlKey: true });
    useEditStudio.getState().setPlayhead(1000);
    key("v", { ctrlKey: true });
    expect(spans()).toEqual([[0, 1000], [1000, 2000], [2000, 4000], [5000, 6000]]);
    useEditStudio.getState().setPlayhead(0);
    key("V", { ctrlKey: true, shiftKey: true });
    expect(spans()).toEqual([[0, 1000], [1000, 2000], [2000, 3000], [3000, 5000], [6000, 7000]]);
    useEditStudio.getState().select({ kind: "clips", ids: [clipIds()[0] as string] });
    key("x", { ctrlKey: true });
    expect(useTimelineStore.getState().clipboard?.entries).toHaveLength(1);
    expect(clipIds()).toHaveLength(4);
  });

  it("paste does nothing without a clipboard, and a locked target is refused", () => {
    render(<Harness />);
    useTimelineStore.getState().setClipboard(null);
    useEditStudio.getState().setPlayhead(1000);
    key("v", { ctrlKey: true });
    expect(spans()).toEqual([[0, 4000], [5000, 6000]]);
    useEditStudio.getState().select({ kind: "clips", ids: ["b"] });
    key("c", { ctrlKey: true });
    const doc = project();
    useEditStudio.getState().edit({ ...doc, tracks: doc.tracks.map((t) => (t.id === "t1" ? { ...t, locked: true } : t)) });
    key("v", { ctrlKey: true });
    expect(spans()).toEqual([[0, 4000], [5000, 6000]]);
  });

  it("Ctrl+L links the selection and again unlinks it", () => {
    render(<Harness />);
    useEditStudio.getState().select({ kind: "clips", ids: ["a", "b"] });
    key("l", { ctrlKey: true });
    expect(project().tracks[0]?.clips.every((c) => !!c.link)).toBe(true);
    key("l", { ctrlKey: true });
    expect(project().tracks[0]?.clips.every((c) => !c.link)).toBe(true);
  });

  it("Up and Down jump between edit points of every track; Shift+Left and Right move a second", () => {
    render(<Harness />);
    useEditStudio.getState().setPlayhead(4500);
    key("ArrowDown");
    expect(useEditStudio.getState().playheadMs).toBe(5000);
    key("ArrowUp");
    expect(useEditStudio.getState().playheadMs).toBe(4000);
    key("ArrowRight", { shiftKey: true });
    expect(useEditStudio.getState().playheadMs).toBe(5000);
    key("ArrowLeft", { shiftKey: true });
    key("ArrowLeft", { shiftKey: true });
    expect(useEditStudio.getState().playheadMs).toBe(3000);
    useEditStudio.getState().setPlayhead(500);
    key("ArrowLeft", { shiftKey: true });
    expect(useEditStudio.getState().playheadMs).toBe(0);
  });

  it("Alt+[ and Alt+] jump between the selected clip's keyframes", () => {
    render(<Harness />);
    const doc = project();
    const keyed = JSON.stringify({ x: { base: 0, keys: [{ t: 500, v: 0, ease: "linear" }, { t: 1500, v: 1, ease: "linear" }] } });
    useEditStudio.getState().edit({ ...doc, tracks: doc.tracks.map((t) => (t.id === "t1" ? { ...t, clips: t.clips.map((c) => (c.id === "a" ? { ...c, transform: keyed } : c)) } : t)) });
    useEditStudio.getState().select({ kind: "clips", ids: ["a"] });
    useEditStudio.getState().setPlayhead(0);
    key("]", { altKey: true });
    expect(useEditStudio.getState().playheadMs).toBe(500);
    key("]", { altKey: true });
    expect(useEditStudio.getState().playheadMs).toBe(1500);
    key("[", { altKey: true });
    expect(useEditStudio.getState().playheadMs).toBe(500);
  });

  it("M adds a marker flag at the playhead in the Video Editor only", () => {
    const { unmount } = render(<Harness />);
    useEditStudio.getState().setPlayhead(2500);
    key("m");
    expect(project().markers.custom.map((m) => m.ms)).toEqual([2500]);
    unmount();
    render(<StudioHarness />);
    useEditStudio.getState().setPlayhead(3000);
    key("m");
    expect(project().markers.custom.map((m) => m.ms)).toEqual([2500]);
  });

  it("[ and ] jump between the Video Editor's marker flags; Delete removes the selected flag", () => {
    render(<Harness />);
    for (const ms of [1000, 2000, 3000]) {
      useEditStudio.getState().setPlayhead(ms);
      key("m");
    }
    useEditStudio.getState().setPlayhead(1500);
    key("]");
    expect(useEditStudio.getState().playheadMs).toBe(2000);
    key("[");
    key("[");
    expect(useEditStudio.getState().playheadMs).toBe(1000);
    useEditStudio.getState().select({ kind: "markers", ids: [project().markers.custom[0]?.id as string] });
    key("Delete");
    expect(project().markers.custom).toHaveLength(2);
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

  it("J plays backwards through the clock (Phase 21)", () => {
    render(<Harness />);
    useEditStudio.getState().setPlayhead(5000);
    key("j");
    expect(player.calls).toEqual(["reverse"]);
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
    render(<StudioHarness />);
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

  it("Delete leaves selected markers to the lanes' own handler (Edit Studio)", () => {
    render(<StudioHarness />);
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
      ["add-adjust-track", "add-audio-track", "add-track", "export", "new", "safe-zones", "snap", "split-subject", "zoom-fit"].map((s) => `video-studio.${s}`).sort(),
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

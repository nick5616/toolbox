import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { defaultTextClip, parseTextClip, serializeTextClip } from "@/viz/edit/schema";
import type { Marker } from "@/viz/edit/types";
import { findClip } from "../doc";
import { useEditStudio } from "../store";
import { placeGenerated } from "../timeline/placeGenerated";

vi.mock("../useEditAutosave", () => ({ flushEdit: vi.fn(async () => undefined) }));
vi.mock("@/lib/api", async (orig) => {
  const m = await orig<typeof import("@/lib/api")>();
  return { ...m, EditStudioService: { ...m.EditStudioService, Fonts: vi.fn(async () => ["Inter"]) } };
});

import { InspectorPanel } from "../inspector/InspectorPanel";
import { textLengthAt } from "./addText";
import { textThroughVideo } from "./textOps";

const st = () => useEditStudio.getState();
const doc = () => st().history!.present;

/** Opens the fixture and puts a text clip (from 100 ms to 3 s) on a new top track. */
function openWithText(): string {
  st().open("p1", "Test", normalizeProject(fixtureProject()));
  const res = placeGenerated(doc(), 100, 2900, { kind: "text", text: serializeTextClip(defaultTextClip("HELLO")), blend: "normal" });
  if (!res) throw new Error("no room");
  st().edit(res.project);
  st().select({ kind: "clips", ids: [res.clipId] });
  return res.clipId;
}
const textOf = (id: string) => parseTextClip(findClip(doc(), id)!.clip.text).value;

beforeEach(() => {
  st().close();
});

describe("TextSection", () => {
  it("edits the text, the counter and the reveal into valid TextClip JSON", () => {
    const id = openWithText();
    render(<InspectorPanel />);
    fireEvent.change(screen.getByRole("textbox", { name: "Text" }), { target: { value: "one two\nthree" } });
    expect(textOf(id).text).toBe("one two\nthree");
    expect(screen.getByLabelText("Character count").textContent).toBe("13/500");
    fireEvent.click(screen.getByRole("radio", { name: "Word by word" }));
    expect(textOf(id).reveal).toBe("words");
    fireEvent.change(screen.getByRole("slider", { name: "Time per word" }), { target: { value: "400" } });
    expect(textOf(id).wordMs).toBe(400);
    fireEvent.click(screen.getByRole("radio", { name: "On the beat" }));
    fireEvent.change(screen.getByRole("slider", { name: "Every" }), { target: { value: "4" } });
    const t = textOf(id);
    expect([t.reveal, t.every]).toEqual(["beats", 4]);
    expect(parseTextClip(findClip(doc(), id)!.clip.text).problems).toEqual([]);
  });

  it("applies a quick style in one click", () => {
    const id = openWithText();
    render(<InspectorPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Subtitle" }));
    const s = textOf(id).style;
    expect([s.preset, s.position, s.uppercase]).toEqual(["subtitle", "lower", false]);
    fireEvent.click(screen.getByRole("button", { name: "Big punch" }));
    const b = textOf(id).style;
    expect([b.preset, b.weight, b.uppercase, b.outline]).toEqual(["pop", 900, true, 0.08]);
  });

  it("Text through video inserts a matted track below the text track", () => {
    const id = openWithText();
    st().setPlayhead(500);
    const before = doc().tracks.length;
    render(<InspectorPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Text through video" }));
    const p = doc();
    expect(p.tracks).toHaveLength(before + 1);
    const ref = findClip(p, id)!;
    const below = p.tracks[ref.trackIndex - 1]!;
    expect(below.matte).toBe("alpha");
    expect(below.kind).toBe("video");
    expect(below.clips).toHaveLength(1);
    expect(below.clips[0]!.startMs).toBeLessThanOrEqual(500);
  });
});

describe("textThroughVideo", () => {
  it("fails without a clip under the playhead, and at 8 tracks", () => {
    const id = openWithText();
    expect(textThroughVideo(doc(), id, 10_000_000).ok).toBe(false);
    const full = { ...doc(), tracks: [...doc().tracks, ...Array.from({ length: 8 }, (_, i) => ({ ...doc().tracks[0]!, id: `x${i}` }))].slice(0, 8) };
    expect(textThroughVideo(full, id, 500).ok).toBe(false);
  });
});

describe("textLengthAt", () => {
  const dm = (ms: number): Marker => ({ id: `downbeat:${ms}`, lane: "downbeat", ms, strength: 1 });
  it("runs to the next downbeat, clamped to 1..4 s, 2 s without markers", () => {
    expect(textLengthAt([], 1000)).toBe(2000);
    expect(textLengthAt([dm(1500), dm(3000)], 1000)).toBe(1000);
    expect(textLengthAt([dm(2600), dm(3000)], 1000)).toBe(1600);
    expect(textLengthAt([dm(9000)], 1000)).toBe(4000);
    expect(textLengthAt([dm(500)], 1000)).toBe(2000);
  });
});

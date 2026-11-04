import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { defaultVisualClip, parseVisualClip, serializeVisualClip } from "@/viz/edit/schema";
import type { Marker } from "@/viz/edit/types";
import { layerDef } from "@/viz/layers/registry";
import { newClip } from "@/editor/doc";
import { findClip } from "@/editor/doc";
import { useEditStudio } from "@/editor/store";
import { addVisualClip, visualLengthAt } from "./addVisual";
import { VisualSection } from "./VisualSection";
import { offeredGroups, offeredLayers, suggestedLayers } from "./visualInfo";

const st = () => useEditStudio.getState();
const get = () => findClip(st().history!.present, "v1")!.clip;

beforeEach(() => {
  st().close();
  const p = normalizeProject(fixtureProject());
  const clip = newClip({ id: "v1", kind: "visual", startMs: 0, endMs: 4000, visual: serializeVisualClip(defaultVisualClip("lightrays")) });
  const t = p.tracks.find((x) => x.kind === "video")!;
  st().open("p1", "Test", { ...p, tracks: p.tracks.map((x) => (x === t ? { ...x, clips: [...x.clips, clip] } : x)) });
});

describe("offered layers", () => {
  it("excludes stateful layers and groups the rest", () => {
    const offered = offeredLayers();
    expect(offered.length).toBeGreaterThan(10);
    expect(offered.every((d) => !d.stateful)).toBe(true);
    expect(offered.some((d) => d.type === "kaleido")).toBe(false);
    expect(offeredGroups().flatMap((g) => g.layers).length).toBe(offered.length);
  });

  it("suggests only layers that exist", () => {
    const s = suggestedLayers().map((d) => d.type);
    expect(s).toContain("lightrays");
    expect(s.every((t) => layerDef(t) !== undefined)).toBe(true);
  });
});

describe("visualLengthAt", () => {
  const sec = (ms: number, endMs: number): Marker => ({ id: `section:${ms}`, lane: "section", ms, endMs, strength: 1 });
  it("runs to the end of the section, clamped to 2..16 s, else 4 s", () => {
    expect(visualLengthAt([], 1000)).toBe(4000);
    expect(visualLengthAt([sec(0, 10_000)], 4000)).toBe(6000);
    expect(visualLengthAt([sec(0, 10_000)], 9500)).toBe(2000);
    expect(visualLengthAt([sec(0, 60_000)], 0)).toBe(16_000);
  });
});

describe("addVisualClip", () => {
  it("adds a screen-blended visual clip", () => {
    st().setPlayhead(20000);
    addVisualClip("embers");
    const sel = st().selection;
    expect(sel?.kind).toBe("clips");
    const id = sel?.kind === "clips" ? sel.ids[0]! : "";
    const c = findClip(st().history!.present, id)!.clip;
    expect(c.kind).toBe("visual");
    expect(c.blend).toBe("screen");
    expect(parseVisualClip(c.visual).value.layer).toBe("embers");
    expect(c.endMs - c.startMs).toBeGreaterThanOrEqual(2000);
  });
});

describe("VisualSection", () => {
  it("changes the layer (resetting params), the palette and params into valid JSON", () => {
    render(<VisualSection clip={get()} />);
    fireEvent.change(screen.getByRole("slider", { name: "Rays" }), { target: { value: "20" } });
    let v = parseVisualClip(get().visual);
    expect(v.problems).toEqual([]);
    expect(v.value.params.rays).toBe(20);

    fireEvent.change(screen.getByLabelText("Palette"), { target: { value: "fire" } });
    v = parseVisualClip(get().visual);
    expect(v.value.palette).toBe("fire");
    expect(v.value.params.rays).toBe(20);

    fireEvent.click(screen.getAllByRole("button", { name: "Suggested: Embers" })[0]!);
    v = parseVisualClip(get().visual);
    expect(v.problems).toEqual([]);
    expect(v.value.layer).toBe("embers");
    expect(v.value.params).toEqual({});
    expect(v.value.palette).toBe("fire");
  });
});

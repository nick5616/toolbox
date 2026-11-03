/** Part B foundation: text/visual clip JSON, mirror edges, blend modes and track mattes in compile. */
import { describe, expect, it } from "vitest";
import type { EditClip } from "@/lib/api";
import { compileEdit } from "./compile";
import { buildEditFixture, fixtureProject } from "./fixture";
import { defaultTextClip, parseTextClip, parseTransform, parseVisualClip, serializeTransform, IDENTITY_TRANSFORM } from "./schema";
import type { EditProject } from "./types";

describe("text clip JSON", () => {
  it("round-trips the default and fills what's missing", () => {
    const d = defaultTextClip("HELLO");
    expect(parseTextClip(JSON.stringify(d))).toMatchObject({ ok: true, value: d });
    const p = parseTextClip(JSON.stringify({ text: "hi", reveal: "beats", lane: "kick", every: 40, wordMs: 1 }));
    expect(p.value).toMatchObject({ text: "hi", reveal: "beats", lane: "kick", every: 16, wordMs: 40 });
    expect(p.value.style.size).toBeGreaterThan(0);
  });
  it("caps the text at 500 characters and reports damage", () => {
    expect(parseTextClip(JSON.stringify({ text: "x".repeat(900) })).value.text).toHaveLength(500);
    expect(parseTextClip("{").ok).toBe(false);
    expect(parseTextClip(JSON.stringify({ text: "a", lane: "nope" })).value.lane).toBe("beat");
  });
});

describe("visual clip JSON", () => {
  it("keeps known layers, palettes and params", () => {
    const v = parseVisualClip(JSON.stringify({ layer: "embers", palette: "fire", params: { density: 0.4, mode: "x", on: true, amt: { base: 0.2, mods: [{ signal: "marker.kick", amount: 0.5, shape: "exp", attackMs: 5, releaseMs: 100 }] } } }));
    expect(v.ok).toBe(true);
    expect(v.value.layer).toBe("embers");
    expect(v.value.palette).toBe("fire");
    expect(v.value.params).toMatchObject({ density: 0.4, mode: "x", on: true });
  });
  it("falls back on unknown layers", () => {
    const v = parseVisualClip(JSON.stringify({ layer: "nope", palette: "nope" }));
    expect(v.ok).toBe(false);
    expect(v.value.layer).toBe("lightrays");
  });
});

describe("mirror edges", () => {
  it("parses and serializes edges", () => {
    expect(parseTransform(JSON.stringify({ edges: "mirror" })).value.edges).toBe("mirror");
    expect(serializeTransform({ ...IDENTITY_TRANSFORM })).toBe("");
    expect(serializeTransform({ ...IDENTITY_TRANSFORM, edges: "mirror" })).toContain("mirror");
    expect(parseTransform(JSON.stringify({ edges: "wrap" })).ok).toBe(false);
  });
});

const analysis = buildEditFixture();

function clip(over: Partial<EditClip> & { id: string; startMs: number; endMs: number }): EditClip {
  return {
    kind: "color", path: "", color: "#ffffff", inMs: 0, speed: "", slow: "", volume: 0, fit: "fill", fitColor: "#000000", flipX: false,
    blend: "normal", transform: "", matte: null, fxTarget: "clip", masks: "", effects: "", in: "", text: "", visual: "", pinned: false, auto: false,
    ...over,
  };
}

function build(p: EditProject) {
  return compileEdit({ project: p, analysis, markers: [], files: { streams: {}, images: {} } }, { width: 540, height: 960, fps: 30 });
}

describe("compile (Part B)", () => {
  it("compiles text and visual clips, skips empty text, keeps shader blend modes", () => {
    const p = fixtureProject();
    p.tracks = [
      {
        id: "t1", kind: "video", name: "V", muted: false, locked: false, matte: "",
        clips: [
          clip({ id: "a", kind: "text", text: JSON.stringify(defaultTextClip("HEY")), startMs: 0, endMs: 1000, blend: "overlay" }),
          clip({ id: "b", kind: "text", text: JSON.stringify({ text: "   " }), startMs: 1000, endMs: 2000 }),
          clip({ id: "c", kind: "visual", visual: JSON.stringify({ layer: "embers" }), startMs: 2000, endMs: 3000 }),
        ],
      },
    ];
    const c = build(p);
    const cl = c.tracks[0]!.clips;
    expect(cl.map((x) => x.id)).toEqual(["a", "c"]);
    expect(cl[0]!.text?.text).toBe("HEY");
    expect(cl[0]!.blend).toBe("overlay");
    expect(cl[1]!.visual?.layer).toBe("embers");
  });

  it("marks the track above a matted track, and drops a matte with nothing above", () => {
    const p = fixtureProject();
    const v = (id: string, matte = "") => ({ id, kind: "video", name: id, muted: false, locked: false, matte, clips: [clip({ id: `${id}c`, startMs: 0, endMs: 1000 })] });
    p.tracks = [v("t1", "alpha"), v("t2"), v("t3", "luma")];
    const c = build(p);
    expect(c.tracks.map((t) => [t.matte, t.isMatte])).toEqual([
      ["alpha", false],
      ["", true],
      ["", false],
    ]);
    expect(c.problems.join("\n")).toContain("tracks[2].matte");
  });
});

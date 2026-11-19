import { describe, expect, it } from "vitest";
import type { GradeOp, GradeRecipe } from "@/grade/types";
import { chaosSeed, mulberry32, surprise } from "./chaos";
import { addOp, fromService, missingMaps, moveOp, patchParam, regionOfKind, removeOp, toService, wildLabel } from "./recipe";
import { lutLeftOut } from "./seams";
import { buildInputs, fitSize, sourceSize } from "./previewInputs";
import { mapFiles } from "./actions";
import { mapReady } from "./recipe";
import { applyGradePlan } from "@/grade/plan";
import { clipAuxOf } from "@/viz/edit/clipAux";
import type { EditSourceState, GradeMapState } from "@/lib/api";

const op = (id: string, over: Partial<GradeOp> = {}): GradeOp => ({ id, kind: "balance", on: true, amount: 1, region: { kind: "all" }, params: {}, ...over });
const recipe = (ops: GradeOp[]): GradeRecipe => ({ v: 1, name: "T", tier: "bold", seed: 1, wildCurve: "linear", ops });

describe("recipe helpers", () => {
  it("round-trips the service recipe", () => {
    const r = recipe([op("aaaaaa", { region: { kind: "near", split: 0.4, feather: 0.1 }, anim: { speed: 1, wave: "sine" }, chaos: true, params: { exposure: 0.5 } })]);
    expect(fromService(toService(r))).toEqual(r);
  });

  it("drops ops of unknown kinds and fills region defaults", () => {
    const s = toService(recipe([op("aaaaaa"), op("bbbbbb")]));
    (s.ops ?? [])[1] = { ...(s.ops ?? [])[1]!, kind: "nope" };
    expect(fromService(s).ops.map((o) => o.id)).toEqual(["aaaaaa"]);
  });

  it("reorders, removes, adds (≤ 16) and edits params", () => {
    let r = recipe([op("a"), op("b"), op("c")]);
    expect(moveOp(r, 0, 2).ops.map((o) => o.id)).toEqual(["b", "c", "a"]);
    expect(moveOp(r, 5, 0)).toBe(r);
    expect(removeOp(r, "b").ops.map((o) => o.id)).toEqual(["a", "c"]);
    expect(patchParam(r, "a", "x", 3).ops[0]?.params).toEqual({ x: 3 });
    for (let i = 0; i < 20; i++) r = addOp(r, "grain");
    expect(r.ops).toHaveLength(16);
    expect(new Set(r.ops.map((o) => o.id)).size).toBe(16);
  });

  it("names the Wildness stops", () => {
    expect([0, 0.2, 0.5, 0.7, 1].map(wildLabel)).toEqual(["Tasteful", "Tasteful", "Bold", "Bold", "Bonkers"]);
  });

  it("says which maps a recipe needs that the input lacks", () => {
    const r = recipe([op("a", { region: regionOfKind("near") }), op("b", { region: regionOfKind("subject") }), op("c", { on: false, region: regionOfKind("people") })]);
    expect(missingMaps(r, { depth: false, subject: false, people: false })).toEqual(["depth", "subject"]);
    expect(missingMaps(r, { depth: true, subject: true, people: false })).toEqual([]);
  });

  it("lists what a LUT can't hold", () => {
    const r = recipe([op("a"), op("b", { region: regionOfKind("subject") }), op("c", { anim: { speed: 1, wave: "sine" } }), op("d", { on: false, region: regionOfKind("far") })]);
    expect(lutLeftOut(r).ops.map((o) => [o.id, o.reason])).toEqual([
      ["b", "region"],
      ["c", "motion"],
    ]);
  });
});

describe("Chaos", () => {
  it("is deterministic for a seed, Wildness and locks", () => {
    const a = surprise({ seed: 4821, wild: 0.7 });
    const b = surprise({ seed: 4821, wild: 0.7 });
    expect(b).toEqual(a);
    expect(surprise({ seed: 4822, wild: 0.7 })).not.toEqual(a);
    expect(a.name).toBe("Chaos #4821");
  });

  it("makes 3 to 8 ops with unique ids, whatever the seed", () => {
    for (let seed = 0; seed < 60; seed++) {
      const r = surprise({ seed, wild: seed % 2 ? 1 : 0 });
      expect(r.ops.length).toBeGreaterThanOrEqual(3);
      expect(r.ops.length).toBeLessThanOrEqual(8);
      expect(new Set(r.ops.map((o) => o.id)).size).toBe(r.ops.length);
    }
  });

  it("keeps locked ops, in place, across rerolls", () => {
    const first = surprise({ seed: 1, wild: 0.5 });
    const keep = [first.ops[1] as GradeOp];
    for (let seed = 2; seed < 8; seed++) {
      const r = surprise({ seed, wild: 0.5, locked: keep });
      expect(r.ops[0]).toEqual(keep[0]);
    }
  });

  it("only animates videos", () => {
    const stills = Array.from({ length: 40 }, (_, i) => surprise({ seed: i, wild: 1 })).flatMap((r) => r.ops);
    expect(stills.every((o) => !o.anim)).toBe(true);
  });

  it("has a stable generator and clamps seeds", () => {
    const g = mulberry32(1);
    expect([g(), g()]).toEqual([mulberry32(1)(), (() => { const x = mulberry32(1); x(); return x(); })()]);
    expect(chaosSeed(-5)).toBe(5);
    expect(chaosSeed(NaN)).toBe(0);
  });
});

describe("preview sizes", () => {
  const src = (w: number, h: number, extra: Partial<EditSourceState["info"]> = {}): EditSourceState =>
    ({ path: "p", info: { path: "p", kind: "image", durationMs: 0, width: w, height: h, fps: 0, rotation: 0, hasAudio: false, takenAt: 0, error: "", ...extra }, preview: null, image: "", shots: [], preparing: false, error: "" }) as unknown as EditSourceState;
  it("swaps a rotated video's sides and falls back to 16:9", () => {
    expect(sourceSize(src(1920, 1080, { kind: "video", rotation: 90 }))).toEqual({ width: 1080, height: 1920 });
    expect(sourceSize(null)).toEqual({ width: 16, height: 9 });
  });
  it("fits inside a box with even sides and a cap", () => {
    expect(fitSize({ width: 4000, height: 3000 }, { width: 800, height: 800 })).toEqual({ width: 800, height: 600 });
    const big = fitSize({ width: 8000, height: 6000 }, { width: 5000, height: 5000 }, 1600);
    expect(big.width).toBe(1600);
    expect(big.width % 2 === 0 && big.height % 2 === 0).toBe(true);
  });
});

describe("region maps in the preview", () => {
  const depthLook: GradeRecipe = { ...recipe([op("aaaaaa", { region: { kind: "subject", feather: 0.3 } }), op("bbbbbb", { kind: "gradmap", params: { source: "depth" } })]) };
  const info = (over: Partial<GradeMapState["depth"]>): GradeMapState["depth"] => ({ ready: false, preview: "", still: "", stream: "", missing: "", ...over });
  const pic = { path: "C:/a.heic", info: { path: "C:/a.heic", kind: "image", durationMs: 0, width: 400, height: 300, fps: 0, rotation: 0 }, preview: null, image: "C:/cache/a.png" } as unknown as EditSourceState;
  const maps = (video: boolean): GradeMapState =>
    ({
      path: "C:/a.heic",
      depth: info(video ? { ready: true, stream: "C:/g/depth-export.h264" } : { ready: true, still: "C:/g/depth.png" }),
      subject: info(video ? { ready: true, stream: "C:/g/subject-export.h264" } : { ready: true, still: "C:/g/subject.png" }),
      people: info(video ? { ready: true, stream: "C:/g/subject-export.h264" } : { ready: true, still: "C:/g/subject.png" }),
      preparing: [],
    }) as GradeMapState;
  const urlsOf = (paths: string[]) => Object.fromEntries(paths.map((p) => [p, `/media/t/${p.split("/").pop()}`]));

  it("lists every map file whose URL the preview needs (streams of both tiers with their indexes)", () => {
    expect(mapFiles(maps(false))).toEqual(["C:/g/depth.png", "C:/g/subject.png"]);
    expect(mapFiles(maps(true))).toEqual([
      "C:/g/depth-export.h264",
      "C:/g/depth-export.idx.json",
      "C:/g/depth-preview.h264",
      "C:/g/depth-preview.idx.json",
      "C:/g/subject-export.h264",
      "C:/g/subject-export.idx.json",
      "C:/g/subject-preview.h264",
      "C:/g/subject-preview.idx.json",
    ]);
  });

  it("attaches a picture's maps the way the export does (d:depth, m:subject), so the effects read them", () => {
    const m = maps(false);
    const inputs = buildInputs({ path: pic.path, src: pic, urls: urlsOf(["C:/cache/a.png", ...mapFiles(m)]), recipe: depthLook, wild: 1, aux: mapReady(m), maps: m, size: { width: 400, height: 300 } });
    expect(inputs).not.toBeNull();
    const files = inputs!.files;
    expect(files.images["d:depth"]).toBe("/media/t/depth.png");
    expect(files.images["m:subject"]).toBe("/media/t/subject.png");
    const clip = inputs!.project.tracks![0]!.clips![0]!;
    expect(clip.matte?.cutout).toBe(false); // the clip still draws whole
    const aux = clipAuxOf(clip, files);
    expect(aux.depth).toEqual({ still: "d:depth" });
    expect(aux.subject).toEqual({ still: "m:subject" });
    // The export's host sees the same thing from the job's plan (modules/grade/run.go).
    const exported = applyGradePlan({ ...inputs!.project, tracks: [{ ...inputs!.project.tracks![0]!, clips: [{ ...clip, effects: "" }] }] }, { recipeJson: JSON.stringify(depthLook), wild: 1 }, files);
    expect(exported.aux).toEqual(aux);
    expect(exported.project.tracks![0]!.clips![0]!.effects).toBe(clip.effects);
  });

  it("uses a video's preview-tier map streams", () => {
    const m = maps(true);
    const vid = { ...pic, info: { ...pic.info, kind: "video", durationMs: 2000, fps: 30 }, preview: { stream: "C:/v.h264", index: "C:/v.idx.json", fps: 30, width: 400, height: 300 }, image: "" } as unknown as EditSourceState;
    const inputs = buildInputs({ path: pic.path, src: vid, urls: urlsOf(["C:/v.h264", "C:/v.idx.json", ...mapFiles(m)]), recipe: depthLook, wild: 1, aux: mapReady(m), maps: m, size: { width: 400, height: 300 } });
    expect(inputs!.files.streams["d:depth"]).toEqual({ url: "/media/t/depth-preview.h264", indexUrl: "/media/t/depth-preview.idx.json" });
    expect(inputs!.files.streams["m:subject"]).toEqual({ url: "/media/t/subject-preview.h264", indexUrl: "/media/t/subject-preview.idx.json" });
    expect(clipAuxOf(inputs!.project.tracks![0]!.clips![0]!, inputs!.files)).toMatchObject({ depth: { stream: "depth" }, subject: { matte: "subject" } });
  });

  it("leaves the maps out (and the ops that need them compile as without) while their URLs aren't there", () => {
    const m = maps(false);
    const inputs = buildInputs({ path: pic.path, src: pic, urls: urlsOf(["C:/cache/a.png"]), recipe: depthLook, wild: 1, aux: mapReady(m), maps: m, size: { width: 400, height: 300 } });
    const clip = inputs!.project.tracks![0]!.clips![0]!;
    expect(clip.depth ?? null).toBeNull();
    expect(clip.matte).toBeNull();
    expect(Object.keys(inputs!.files.images)).toEqual(["p:C:/a.heic"]);
  });
});

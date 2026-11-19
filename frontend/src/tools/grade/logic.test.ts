import { describe, expect, it } from "vitest";
import type { GradeOp, GradeRecipe } from "@/grade/types";
import { chaosSeed, mulberry32, surprise } from "./chaos";
import { addOp, fromService, missingMaps, moveOp, patchParam, regionOfKind, removeOp, toService, wildLabel } from "./recipe";
import { lutLeftOut } from "./seams";
import { fitSize, sourceSize } from "./previewInputs";
import type { EditSourceState } from "@/lib/api";

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

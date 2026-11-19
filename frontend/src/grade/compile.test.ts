import { describe, expect, it } from "vitest";
import "@/viz/post";
import { postDef } from "@/viz/post/registry";
import { resolvePostParams } from "@/viz/edit/clip";
import { evalEditParam } from "@/viz/edit/params";
import type { EditParam, EditPost } from "@/viz/edit/types";
import { compileRecipe, flashSafe, MAX_POSTS, opAmount, wildCurve, wildGain } from "./compile";
import { BUILT_IN_LOOKS, builtInLook } from "./builtins";
import { parseTable } from "./pack";
import { CHAOS_ABOVE, type GradeAuxState, type GradeOp, type GradeRecipe } from "./types";

const ALL: GradeAuxState = { depth: true, subject: true, people: true };
const NONE: GradeAuxState = { depth: false, subject: false, people: false };

/** FNV-1a of a string, for compact golden hashes. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** One line per post: type, the table's op kinds (gradelook), and a hash of the whole post. */
function outline(posts: EditPost[]): string[] {
  return posts.map((p) => {
    const t = typeof p.params.table === "string" ? parseTable(p.params.table).ops.map((o) => o.kind).join("+") : "";
    const gate = p.params.stash ? "stash" : p.params.restore ? "restore" : "";
    return `${p.id} ${p.type}${t ? `[${t}]` : ""}${gate ? ` ${gate}` : ""} #${hash(JSON.stringify(p))}`;
  });
}

const op = (over: Partial<GradeOp> & Pick<GradeOp, "kind">): GradeOp => ({ id: "aaaaaa", on: true, amount: 1, region: { kind: "all" }, params: {}, ...over });
const recipe = (ops: GradeOp[], curve: GradeRecipe["wildCurve"] = "linear"): GradeRecipe => ({ v: 1, name: "t", tier: "mine", seed: 0, wildCurve: curve, ops });

describe("Wildness", () => {
  it("curves: linear, late (slow start), early (fast start); gain runs 0.2 → 1", () => {
    expect(wildCurve("linear", 0.5)).toBe(0.5);
    expect(wildCurve("late", 0.5)).toBe(0.25);
    expect(wildCurve("early", 0.5)).toBe(0.75);
    for (const c of ["linear", "late", "early"] as const) {
      expect(wildGain(c, 0)).toBeCloseTo(0.2, 9);
      expect(wildGain(c, 1)).toBeCloseTo(1, 9);
      expect(wildCurve(c, -3)).toBe(0);
      expect(wildCurve(c, 9)).toBe(1);
    }
  });

  it("chaos ops are off up to 0.66 and ramp in above it; off ops and zero amounts give nothing", () => {
    const chaos = op({ kind: "glow", chaos: true });
    expect(opAmount(chaos, CHAOS_ABOVE, "linear")).toBe(0);
    expect(opAmount(chaos, 0.3, "linear")).toBe(0);
    expect(opAmount(chaos, 0.7, "linear")).toBeGreaterThan(0);
    expect(opAmount(chaos, 1, "linear")).toBeCloseTo(1, 9);
    expect(opAmount(chaos, 0.8, "linear")).toBeGreaterThan(opAmount(chaos, 0.7, "linear"));
    expect(opAmount(op({ kind: "glow", on: false }), 1, "linear")).toBe(0);
    expect(opAmount(op({ kind: "glow", amount: 0.5 }), 1, "linear")).toBe(0.5);
  });

  it("a look's amounts grow with the Wildness", () => {
    const l = (builtInLook("acid-bath") as NonNullable<ReturnType<typeof builtInLook>>).recipe;
    const amount = (w: number) => (parseTable(compileRecipe(l, w, ALL)[0]?.params.table as string).ops[0]?.amount ?? 0);
    expect(amount(0)).toBeLessThan(amount(0.5));
    expect(amount(0.5)).toBeLessThan(amount(1));
  });
});

describe("compileRecipe structure", () => {
  it("is empty for an empty recipe and for ops that are off or inactive", () => {
    expect(compileRecipe(recipe([]), 0.5, ALL)).toEqual([]);
    expect(compileRecipe(recipe([op({ kind: "balance", on: false })]), 0.5, ALL)).toEqual([]);
    expect(compileRecipe(recipe([op({ kind: "glow", chaos: true })]), 0.5, ALL)).toEqual([]);
  });

  it("puts consecutive colour ops (and grain/vignette) into one gradelook post, in recipe order", () => {
    const posts = compileRecipe(recipe([op({ id: "a00001", kind: "balance" }), op({ id: "a00002", kind: "split" }), op({ id: "a00003", kind: "grain" }), op({ id: "a00004", kind: "vignette" })]), 1, ALL);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.type).toBe("gradelook");
    expect(parseTable(posts[0]?.params.table as string).ops.map((o) => o.kind)).toEqual(["balance", "split", "grain", "vignette"]);
  });

  it("splits runs around spatial passes and maps their params", () => {
    const posts = compileRecipe(
      recipe([op({ id: "b00001", kind: "balance" }), op({ id: "b00002", kind: "chromatic", params: { px: 10 }, amount: 0.5 }), op({ id: "b00003", kind: "grain" })]),
      1,
      ALL,
    );
    expect(posts.map((p) => p.type)).toEqual(["gradelook", "chromatic", "gradelook"]);
    expect(posts[1]?.params).toEqual({ amount: 5, source: "amount" });
    expect(new Set(posts.map((p) => p.id)).size).toBe(3);
  });

  it("every spatial kind compiles to a registered pass whose params are in range", () => {
    const kinds = ["glow", "halation", "edgeglow", "depthfog", "tiltshift", "chromatic", "halftone", "glitch", "vhs", "sharpen", "mirror"] as const;
    for (const kind of kinds) {
      const posts = compileRecipe(recipe([op({ kind, id: "c00001" })]), 1, ALL);
      expect(posts, kind).toHaveLength(1);
      const p = posts[0] as EditPost;
      const def = postDef(p.type);
      expect(def, kind).toBeTruthy();
      for (const [k, v] of Object.entries(p.params)) {
        const spec = def?.params[k];
        expect(spec, `${kind}.${k} is a param of ${p.type}`).toBeTruthy();
        if (spec?.kind === "number" && typeof v === "number") {
          expect(v, `${kind}.${k}`).toBeGreaterThanOrEqual(spec.min);
          expect(v, `${kind}.${k}`).toBeLessThanOrEqual(spec.max);
        }
      }
      // resolves like the engine does
      const resolved = resolvePostParams(def?.params ?? {}, p.params, 0, 0, null);
      expect(Object.keys(resolved).length).toBeGreaterThan(0);
    }
  });

  it("gates a spatial op with a region in a stash/restore sandwich", () => {
    const posts = compileRecipe(recipe([op({ id: "d00001", kind: "glitch", region: { kind: "background", feather: 0.2 } })]), 1, ALL);
    expect(posts.map((p) => p.id)).toEqual(["d00001s", "d00001", "d00001r"]);
    expect(posts[0]?.params).toEqual({ stash: "gd00001" });
    expect(posts[2]?.params.restore).toBe("gd00001");
    const gate = parseTable(posts[2]?.params.table as string).ops[0];
    expect(gate).toMatchObject({ kind: "gate", amount: 1, region: { kind: "background" } });
  });

  it("a stash and its restore share a key and a pass can resolve both", () => {
    const posts = compileRecipe(recipe([op({ id: "d00002", kind: "vhs", region: { kind: "far", split: 0.5, feather: 0.2 } })]), 1, ALL);
    const def = postDef("gradelook");
    for (const p of posts.filter((x) => x.type === "gradelook")) {
      const v = resolvePostParams(def?.params ?? {}, p.params, 0, 0, null);
      expect(typeof v.table).toBe("string");
      expect(typeof v.stash).toBe("string");
      expect(typeof v.restore).toBe("string");
    }
  });

  it("people falls back to subject when only that map exists; depth ops are left out without depth", () => {
    const r = recipe([op({ id: "e00001", kind: "balance", region: { kind: "people", feather: 0.3 } }), op({ id: "e00002", kind: "depthfog" }), op({ id: "e00003", kind: "tiltshift" })]);
    const sub = compileRecipe(r, 1, { depth: false, subject: true, people: false });
    expect(sub).toHaveLength(1);
    expect(parseTable(sub[0]?.params.table as string).ops[0]?.region.kind).toBe("subject");
    const both = compileRecipe(r, 1, ALL);
    expect(parseTable(both[0]?.params.table as string).ops[0]?.region.kind).toBe("people");
    expect(both.map((p) => p.type)).toEqual(["gradelook", "depthfog", "tiltshift"]);
    expect(compileRecipe(r, 1, NONE).map((p) => p.type)).toEqual(["gradelook"]);
  });

  it("never returns more than 8 effects: the weakest spatial ops are dropped first", () => {
    for (const l of BUILT_IN_LOOKS) for (const w of [0, 0.5, 1]) expect(compileRecipe(l.recipe, w, ALL).length, `${l.id} @${w}`).toBeLessThanOrEqual(MAX_POSTS);
    const kinds = ["vhs", "glitch", "halftone", "chromatic", "sharpen", "mirror", "halation", "edgeglow"] as const;
    const ops = kinds.map((kind, i) => op({ id: `s0000${i}`, kind, amount: 1 - i * 0.1, region: { kind: "background", feather: 0.2 } }));
    const posts = compileRecipe(recipe([op({ id: "c00000", kind: "balance" }), ...ops]), 1, ALL);
    expect(posts.length).toBeLessThanOrEqual(MAX_POSTS);
    expect(posts[0]?.type).toBe("gradelook");
    const kept = posts.filter((p) => p.type !== "gradelook").map((p) => p.type);
    expect(kept).toContain("vhs"); // the strongest stay
    expect(kept).not.toContain("edgeglow"); // the weakest go
    // gates stay whole: every restore has its stash
    const stashes = posts.filter((p) => p.params.stash).length;
    expect(posts.filter((p) => p.params.restore).length).toBe(stashes);
    // a clean recipe is untouched
    expect(compileRecipe(recipe([op({ kind: "vhs" })]), 1, ALL)).toHaveLength(1);
  });

  it("is deterministic", () => {
    for (const l of BUILT_IN_LOOKS.slice(0, 10)) expect(JSON.stringify(compileRecipe(l.recipe, 0.7, ALL))).toBe(JSON.stringify(compileRecipe(l.recipe, 0.7, ALL)));
  });
});

describe("animation and flash safety", () => {
  const beat = (kind: GradeOp["kind"], amount = 1) => op({ id: "f00001", kind, amount, anim: { speed: 1, wave: "beat" } });

  it("beat and bar waves become drive params with a 120 ms attack and 300 ms release", () => {
    const [p] = compileRecipe(recipe([beat("balance")]), 1, ALL);
    const d0 = p?.params.d0 as EditParam;
    expect(typeof d0).toBe("object");
    const mod = (d0 as { mods: Array<{ signal: string; attackMs: number; releaseMs: number; shape: string }> }).mods[0];
    expect(mod).toMatchObject({ signal: "beat.pulse", attackMs: 120, releaseMs: 300, shape: "linear" });
    const [q] = compileRecipe(recipe([op({ kind: "balance", anim: { speed: 1, wave: "bar" } })]), 1, ALL);
    expect(((q?.params.d0 as { mods: Array<{ signal: string }> }).mods[0] as { signal: string }).signal).toBe("bar.pulse");
    expect(parseTable(p?.params.table as string).ops[0]?.anim?.wave).toBe("ext");
    // the drive evaluates to the pulse (no analysis: 0)
    expect(evalEditParam(d0, 0, 1, 0, 0, null)).toBe(0);
  });

  it("sine and saw waves are computed in the pass; ops that can't animate ignore anim", () => {
    const [p] = compileRecipe(recipe([op({ kind: "balance", anim: { speed: 2, wave: "sine" } })]), 1, ALL);
    expect(parseTable(p?.params.table as string).ops[0]?.anim).toMatchObject({ wave: "sine", speed: 2 });
    expect(p?.params.d0).toBeUndefined();
    const [q] = compileRecipe(recipe([op({ kind: "wheels", anim: { speed: 2, wave: "sine" } })]), 1, ALL);
    expect(parseTable(q?.params.table as string).ops[0]?.anim).toBeUndefined();
  });

  it("an animated spatial op is gated so the pulse mixes the effect in and out", () => {
    const posts = compileRecipe(recipe([op({ id: "g00001", kind: "halation", anim: { speed: 1, wave: "beat" } })]), 1, ALL);
    expect(posts.map((p) => p.id)).toEqual(["g00001s", "g00001", "g00001r"]);
    expect(posts[2]?.params.d0).toBeTruthy();
  });

  it("flash safety: beat pulses of strong ops are limited to a 10% swing, bars may swing fully, sine speeds are in range", () => {
    const strong = flashSafe("solarize", 1, "beat", 1);
    expect(strong.depth * 1 * 0.5).toBeLessThanOrEqual(0.1 + 1e-9);
    const weak = flashSafe("grain", 1, "beat", 1);
    expect(weak.depth).toBeLessThanOrEqual(0.7);
    expect(flashSafe("solarize", 1, "bar", 1).depth).toBe(0.7);
    for (const wave of ["sine", "saw"] as const) {
      const s = flashSafe("solarize", 1, wave, 6);
      expect(s.speed / 10).toBeLessThanOrEqual(1.5);
    }
    expect(flashSafe("balance", 1, "sine", 99).speed).toBe(6);
    expect(flashSafe("balance", 1, "sine", 0).speed).toBe(0.05);
  });
});

describe("the 40 built-in looks", () => {
  it("compile at Wildness 0, 0.5 and 1 (goldens)", () => {
    const out: Record<string, string[]> = {};
    for (const l of BUILT_IN_LOOKS) {
      for (const w of [0, 0.5, 1]) {
        const posts = compileRecipe(l.recipe, w, ALL);
        out[`${l.id} @${w}`] = outline(posts);
        for (const p of posts) {
          expect(postDef(p.type), `${l.id}: ${p.type} is registered`).toBeTruthy();
          expect(p.enabled).toBe(true);
        }
      }
    }
    expect(out).toMatchSnapshot();
  });

  it("every look shows something at 0.5 except Clean's chaos-free subtlety, and chaos ops appear only above 0.66", () => {
    for (const l of BUILT_IN_LOOKS) {
      expect(compileRecipe(l.recipe, 0.5, ALL).length, l.id).toBeGreaterThan(0);
      const chaosOps = l.recipe.ops.filter((o) => o.chaos);
      if (chaosOps.length === 0) continue;
      const types = (w: number) => compileRecipe(l.recipe, w, ALL).map((p) => p.type);
      const kinds = new Set(chaosOps.map((o) => o.kind));
      for (const k of kinds) {
        const spatial = ["edgeglow", "chromatic", "glitch", "glow", "halation"].includes(k);
        if (spatial) {
          expect(types(0.5), `${l.id} at 0.5`).not.toContain(k);
          expect(types(1), `${l.id} at 1`).toContain(k);
        }
      }
    }
  });

  it("Neon Noir gains edge glow and a chromatic split only at Bonkers", () => {
    const l = (builtInLook("neon-noir") as NonNullable<ReturnType<typeof builtInLook>>).recipe;
    const at = (w: number) => compileRecipe(l, w, ALL).map((p) => p.type);
    expect(at(0.5)).not.toContain("edgeglow");
    expect(at(0.5)).not.toContain("chromatic");
    expect(at(0.66)).not.toContain("edgeglow");
    expect(at(0.8)).toContain("edgeglow");
    expect(at(1)).toContain("chromatic");
  });

  it("have the ids the step default and the spec name", () => {
    for (const id of ["teal-orange", "neon-noir", "depth-rainbow", "acid-bath", "vaporwave-mall", "inferno-by-depth"]) expect(builtInLook(id), id).toBeTruthy();
    expect(BUILT_IN_LOOKS.filter((l) => l.recipe.tier === "film")).toHaveLength(12);
    expect(BUILT_IN_LOOKS.filter((l) => l.recipe.tier === "bold")).toHaveLength(12);
    expect(BUILT_IN_LOOKS.filter((l) => l.recipe.tier === "bonkers")).toHaveLength(16);
  });

  it("depth looks don't crash without depth: the fog is left out, the rest is there", () => {
    const l = (builtInLook("inferno-by-depth") as NonNullable<ReturnType<typeof builtInLook>>).recipe;
    expect(compileRecipe(l, 1, NONE).map((p) => p.type)).not.toContain("depthfog");
    expect(compileRecipe(l, 1, ALL).map((p) => p.type)).toContain("depthfog");
  });
});

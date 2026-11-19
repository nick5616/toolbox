/**
 * Chaos / "Surprise me" (Phase 21 SPEC §E1): a random recipe of 3..8 ops from the op catalog, weighted by
 * Wildness. Deterministic: the same (seed, wildness, kept ops) always gives the same recipe (seeded mulberry32,
 * no clock, no Math.random), so a typed-in seed `#4821` reproduces a look exactly.
 *
 * Wildness decides the mix: low values favour the tasteful kinds (balance, wheels, curves, split, bleach,
 * grain, vignette, halation, sharpen), high values the wild ones (gradmap, chanmix, huecycle, solarize,
 * posterize, invert, edge glow, glitch, kaleidoscope, halftone) and add more ops. The loudest kinds are marked
 * `chaos`, so they only switch on above Wildness 0.66 anyway. `keep` are the locked ops (🔒): they stay, in
 * order, at the front, and their kinds aren't drawn again.
 */
import { evenStops, srgbToHex } from "./color";
import { hsvToRgb } from "./math";
import { OP_DEFS } from "./ops";
import { MAX_OPS, type GradeOp, type GradeOpKind, type GradeParam, type GradeRecipe, type Region } from "./types";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TASTEFUL: GradeOpKind[] = ["balance", "wheels", "curves", "hsl", "split", "bleach", "grain", "vignette", "halation", "sharpen", "glow"];
const WILD: GradeOpKind[] = ["gradmap", "chanmix", "huecycle", "solarize", "posterize", "invert", "edgeglow", "glitch", "mirror", "halftone", "chromatic", "vhs"];
/** Kinds that are marked `chaos` (only above Wildness 0.66). */
const LOUD = new Set<GradeOpKind>(["edgeglow", "glitch", "mirror", "halftone", "chromatic", "invert", "solarize"]);
/** Kinds that need a depth map: left out (the generator doesn't know which maps exist). */
const BASE_WEIGHT: Partial<Record<GradeOpKind, number>> = { balance: 3, split: 2, gradmap: 2, huecycle: 1.5, mirror: 0.25, invert: 0.4, glitch: 0.6, sharpen: 0.6, posterize: 0.8 };

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

export function surprise(seed: number, wild: number, keep: readonly GradeOp[] = []): GradeRecipe {
  const rnd = mulberry32(seed);
  const w = Math.max(0, Math.min(1, wild));
  const uni = (lo: number, hi: number) => lo + (hi - lo) * rnd();
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length] as T;
  const ids = new Set(keep.map((o) => o.id));
  const newId = (): string => {
    for (;;) {
      let s = "";
      for (let i = 0; i < 6; i++) s += ID_CHARS[Math.floor(rnd() * ID_CHARS.length)];
      if (!ids.has(s)) {
        ids.add(s);
        return s;
      }
    }
  };

  const free = Math.max(0, Math.min(8, MAX_OPS) - keep.length);
  const target = Math.min(free, Math.max(3, 3 + Math.floor(rnd() * (2 + Math.round(w * 4)))));
  const used = new Set<GradeOpKind>(keep.map((o) => o.kind));
  const ops: GradeOp[] = [...keep];

  const weight = (k: GradeOpKind): number => {
    if (used.has(k)) return 0;
    const base = BASE_WEIGHT[k] ?? 1;
    if (WILD.includes(k)) return base * (0.1 + 2.6 * w * w);
    if (TASTEFUL.includes(k)) return base * (1.7 - 1.2 * w);
    return 0;
  };

  const color = (sat: number, val: number): string => srgbToHex(hsvToRgb(uni(0, 360), sat, val));
  const hue = (): number => uni(0, 360);
  const palette = (): string => {
    const h = hue();
    const spread = pick([30, 60, 120, 180]);
    const hs = [h, h + spread, h + spread * 2];
    return evenStops(...hs.map((x, i) => srgbToHex(hsvToRgb(x, uni(0.55, 0.95), i === 0 ? uni(0.05, 0.3) : i === 1 ? uni(0.6, 0.95) : uni(0.85, 1)))));
  };
  const sym = (r: number) => uni(-r, r);

  const params = (k: GradeOpKind): Record<string, GradeParam> => {
    switch (k) {
      case "balance":
        return { exposure: sym(0.4), temp: sym(0.6), tint: sym(0.3), contrast: uni(0.85, 1.2 + 0.8 * w), saturation: uni(0.7, 1.2 + 0.8 * w), vibrance: sym(0.5) };
      case "wheels":
        return { lift: [sym(0.3), sym(0.3), sym(0.3)], gamma: [sym(0.4), sym(0.4), sym(0.4)], gain: [sym(0.4), sym(0.4), sym(0.4)], offset: sym(0.1) };
      case "curves": {
        const f = uni(0, 0.12);
        const s = uni(-0.08, 0.1);
        const ch = () => [0, 0.25 - s + sym(0.03), 0.5 + sym(0.03), 0.75 + s + sym(0.03), 1].map((v, i) => Math.max(0, Math.min(1, i === 0 ? f * 0.6 : i === 4 ? 1 - f * 0.4 : v)));
        return { master: ch(), r: ch(), g: ch(), b: ch() };
      }
      case "hsl": {
        const a = () => Array.from({ length: 6 }, () => sym(1));
        return { hue: a().map((v) => v * (30 + 120 * w)), sat: a().map((v) => v * 0.5), lum: a().map((v) => v * 0.3) };
      }
      case "split":
        return { shadow: color(uni(0.5, 0.95), uni(0.2, 0.5)), highlight: color(uni(0.4, 0.9), uni(0.8, 1)), balance: sym(0.5) };
      case "gradmap":
        return { stops: palette(), source: pick(["luma", "luma", "hue"]), blend: pick(["replace", "color", "soft"]), drift: 0 };
      case "chanmix": {
        const m = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (let r = 0; r < 3; r++) {
          const dom = Math.floor(rnd() * 3);
          for (let c = 0; c < 3; c++) m[r * 3 + c] = c === dom ? uni(0.7, 1.1) : sym(0.5) * (0.3 + w);
        }
        return { matrix: m };
      }
      case "solarize":
        return { threshold: uni(0.35, 0.7), mix: uni(0.5, 1) };
      case "posterize":
        return { levels: Math.round(uni(3, 8)) };
      case "invert":
        return rnd() < 0.5 ? { r: true, g: true, b: true } : { r: rnd() < 0.5, g: rnd() < 0.5, b: true };
      case "huecycle":
        return { by: pick(["luma", "luma", "radius"]), cycles: uni(0.4, 1 + 2.4 * w), phase: uni(0, 1) };
      case "bleach":
        return { mix: uni(0.6, 1) };
      case "glow":
        return { threshold: uni(0.3, 0.8), radius: uni(0.3, 0.9), tint: color(uni(0.1, 0.7), 1), gain: uni(0.5, 1.5) };
      case "halation":
        return { threshold: uni(0.4, 0.7), radius: uni(0.3, 0.8), tint: color(uni(0.5, 0.9), 1) };
      case "edgeglow":
        return { color: color(uni(0.6, 1), 1), thickness: uni(1, 2.5), strength: uni(0.8, 1.6) };
      case "grain":
        return { size: uni(1, 2), colored: uni(0, 0.5) };
      case "vignette":
        return { size: uni(0.35, 0.65), softness: uni(0.5, 0.9), roundness: uni(0.2, 1) };
      case "chromatic":
        return { px: uni(2, 12) };
      case "halftone":
        return { dots: Math.round(uni(50, 140)), angle: Math.round(sym(60)), mode: pick(["mono", "color"]) };
      case "vhs":
        return { scanlines: uni(0.2, 0.8), bleed: uni(0.2, 0.8), wobble: uni(0.1, 0.5), noise: uni(0.1, 0.5) };
      case "sharpen":
        return { gain: uni(0.5, 1.5) };
      case "mirror":
        return { segments: Math.round(uni(3, 8)), spin: sym(0.4), zoom: uni(0.8, 1.4) };
      default:
        return {};
    }
  };

  const region = (): Region => {
    if (rnd() > 0.25 * w + 0.05) return { kind: "all" };
    const k = pick(["highlights", "shadows", "midtones"] as const);
    return { kind: k, soft: uni(0.3, 0.7) };
  };

  for (let n = 0; n < target; n++) {
    // the first op is usually a base grade
    if (n === 0 && !used.has("balance") && rnd() < 0.6) {
      used.add("balance");
      ops.push({ id: newId(), kind: "balance", on: true, amount: uni(0.7, 1), region: { kind: "all" }, params: params("balance") });
      continue;
    }
    const kinds = [...TASTEFUL, ...WILD];
    const ws = kinds.map(weight);
    const total = ws.reduce((a, b) => a + b, 0);
    if (total <= 0) break;
    let r = rnd() * total;
    let kind = kinds[0] as GradeOpKind;
    for (let i = 0; i < kinds.length; i++) {
      r -= ws[i] as number;
      if (r <= 0) {
        kind = kinds[i] as GradeOpKind;
        break;
      }
    }
    used.add(kind);
    const op: GradeOp = { id: newId(), kind, on: true, amount: uni(0.55, 1), region: kind === "mirror" ? { kind: "all" } : region(), params: params(kind) };
    if (LOUD.has(kind)) op.chaos = true;
    if ((kind === "huecycle" || kind === "gradmap") && rnd() < 0.3) op.anim = { speed: uni(0.3, 1.5), wave: "sine" };
    ops.push(op);
  }

  // Make sure every param is in range (the generator's ranges are inside the schema, but the clamp is the contract).
  const clamped = ops.map((o) => (keep.includes(o) ? o : { ...o, params: clampAll(o.kind, o.params) }));
  return { v: 1, name: `Chaos #${seed >>> 0}`, tier: "mine", seed: seed >>> 0, wildCurve: "linear", ops: clamped };
}

function clampAll(kind: GradeOpKind, p: Record<string, GradeParam>): Record<string, GradeParam> {
  const out: Record<string, GradeParam> = {};
  for (const [k, spec] of Object.entries(OP_DEFS[kind].params)) {
    const v = p[k];
    if (v === undefined) continue;
    if (spec.kind === "number" && typeof v === "number") out[k] = Math.max(spec.min ?? -Infinity, Math.min(spec.max ?? Infinity, v));
    else if ((spec.kind === "points" || spec.kind === "matrix") && Array.isArray(v)) out[k] = v.map((x) => Math.max(spec.min ?? -Infinity, Math.min(spec.max ?? Infinity, x)));
    else out[k] = v;
  }
  return out;
}

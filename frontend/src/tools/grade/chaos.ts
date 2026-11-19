/**
 * Chaos (Phase 21 SPEC §E1): "Surprise me" builds a random look of 3–8 ops
 * from the op catalog, weighted by Wildness, from a seeded mulberry32. The same
 * seed, Wildness and locks always give the same recipe, so `#4821` typed in
 * later reproduces the look. A locked op keeps its place across rerolls.
 */
import { opDef } from "@/grade/ops";
import { GRADE_OP_KINDS, MAX_OPS, RECIPE_VERSION, type GradeAnim, type GradeOp, type GradeOpKind, type GradeParam, type GradeRecipe, type OpParamSpec } from "@/grade/types";
import { clamp01, newOpId } from "./recipe";

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

/** How tasteful each kind is: 1 = at home in a grade, 0 = only for the unhinged. */
const TASTE: Partial<Record<GradeOpKind, number>> = {
  balance: 1, wheels: 0.9, curves: 0.9, hsl: 0.8, split: 0.9, bleach: 0.7, vignette: 0.9, grain: 0.9, sharpen: 0.6, glow: 0.6, halation: 0.7, tiltshift: 0.5,
  gradmap: 0.3, transfer: 0.5, depthfog: 0.4, chromatic: 0.3, vhs: 0.2, chanmix: 0.2, solarize: 0.1, posterize: 0.15, invert: 0.05, huecycle: 0.1, halftone: 0.1, glitch: 0.05, mirror: 0.05, edgeglow: 0.2,
};

/** Kinds Chaos can't use without data it doesn't have (a reference picture). */
const SKIP: ReadonlySet<GradeOpKind> = new Set(["transfer"]);

export function chaosSeed(n: number): number {
  return Math.abs(Math.trunc(Number.isFinite(n) ? n : 0)) % 0x100000000;
}

/** Weighted pick; kinds that suit the Wildness weigh more. */
function pickKind(rand: () => number, wild: number, taken: ReadonlySet<GradeOpKind>, avail: readonly GradeOpKind[]): GradeOpKind {
  const pool = avail.filter((k) => !taken.has(k));
  const use = pool.length > 0 ? pool : avail;
  const weights = use.map((k) => {
    const taste = TASTE[k] ?? 0.5;
    // Tasteful at 0, the unhinged at 1; never zero.
    return 0.15 + (wild < 0.5 ? taste * (1 - wild) : (1 - taste) * wild + 0.2);
  });
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  for (const [i, w] of weights.entries()) {
    r -= w;
    if (r <= 0) return use[i] as GradeOpKind;
  }
  return use[use.length - 1] as GradeOpKind;
}

function hex(rand: () => number): string {
  const c = () => Math.floor(rand() * 256).toString(16).padStart(2, "0");
  return `#${c()}${c()}${c()}`;
}

function randomParam(spec: OpParamSpec, rand: () => number, wild: number): GradeParam {
  switch (spec.kind) {
    case "number": {
      const min = spec.min ?? 0;
      const max = spec.max ?? 1;
      const def = typeof spec.default === "number" ? spec.default : (min + max) / 2;
      // The reach around the default grows with Wildness.
      const reach = (max - min) * (0.12 + 0.38 * wild);
      return Math.round(Math.min(max, Math.max(min, def + (rand() - 0.5) * 2 * reach)) * 1000) / 1000;
    }
    case "color":
      return hex(rand);
    case "enum":
      return spec.options && spec.options.length > 0 ? (spec.options[Math.floor(rand() * spec.options.length)] as string) : spec.default;
    case "bool":
      return rand() < 0.5 ? !!spec.default : !spec.default;
    default:
      return Array.isArray(spec.default) ? [...spec.default] : spec.default;
  }
}

export interface SurpriseOptions {
  seed: number;
  wild: number;
  /** Ops that stay (in this order, first). */
  locked?: readonly GradeOp[];
  /** Kinds Chaos may use (default: the catalog's). */
  kinds?: readonly GradeOpKind[];
  /** Videos: some ops get motion. */
  video?: boolean;
}

/** The look for a seed. Deterministic: (seed, wild, locked, kinds) → recipe. */
export function surprise({ seed: rawSeed, wild, locked = [], kinds, video }: SurpriseOptions): GradeRecipe {
  const seed = chaosSeed(rawSeed);
  const rand = mulberry32(seed);
  const w = clamp01(wild);
  const avail = (kinds ?? GRADE_OP_KINDS).filter((k) => !SKIP.has(k) && (opDef(k) !== undefined || kinds !== undefined || Object.keys(TASTE).includes(k)));
  const want = Math.min(MAX_OPS, Math.max(locked.length, 3 + Math.floor(rand() * (3 + Math.round(w * 3)))));
  const ops: GradeOp[] = locked.map((o) => ({ ...o, params: { ...o.params } }));
  const ids = new Set(ops.map((o) => o.id));
  const used = new Set<GradeOpKind>(ops.map((o) => o.kind));
  while (ops.length < want && avail.length > 0) {
    const kind = pickKind(rand, w, used, avail);
    used.add(kind);
    const def = opDef(kind);
    const params: Record<string, GradeParam> = {};
    for (const [k, spec] of Object.entries(def?.params ?? {})) params[k] = randomParam(spec, rand, w);
    const wildKind = (TASTE[kind] ?? 0.5) < 0.4;
    const region: GradeOp["region"] = rand() < 0.2 + 0.2 * w ? { kind: rand() < 0.5 ? "highlights" : "shadows", soft: 0.3 } : { kind: "all" };
    const op: GradeOp = {
      id: newOpId(ids, rand),
      kind,
      on: true,
      amount: Math.round((0.45 + 0.55 * rand()) * 100) / 100,
      region,
      params,
    };
    if (wildKind && rand() < 0.5) op.chaos = true;
    if (video && def?.animatable && rand() < 0.35) {
      const wave: GradeAnim["wave"] = rand() < 0.5 ? "sine" : "saw";
      op.anim = { speed: Math.round((0.2 + rand() * 1.2) * 100) / 100, wave };
    }
    ids.add(op.id);
    ops.push(op);
  }
  return { v: RECIPE_VERSION, name: `Chaos #${seed}`, tier: "mine", seed, wildCurve: "linear", ops };
}

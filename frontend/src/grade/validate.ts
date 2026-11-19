/**
 * Recipe validation (Phase 21 SPEC §E4), the same semantics as modules/grade/recipe.go; both run the
 * vectors in core/testdata/grade-recipes.json.
 *
 * Fatal (the recipe is refused): not an object, `v` not 1, `ops` not an array, two ops with the same id,
 * an op id that isn't 1..6 characters of [A-Za-z0-9_-].
 * Fixed (never fatal):
 * - unknown op kinds are dropped; more than 16 ops keep the first 16;
 * - name: trimmed, cut to 40 characters (code points), "" becomes "Untitled";
 * - tier not in the list → "ai"; wildCurve not in the list → "linear"; seed → floored and clamped to 0..4294967295;
 * - an op: `on` defaults to true, `chaos` is kept only when true, `amount` clamped 0..1 (a non-number is 1),
 *   `anim` speed clamped 0.05..6 and wave defaulting to "sine";
 * - a region: unknown kind → all; soft (default 0.5), feather (0.2), split (0.5) clamped 0..1; `invert` only for
 *   subject/background/people, kept only when true; fields a kind doesn't use are dropped;
 * - params: only known keys of the kind survive, each clamped by its OpParamSpec (see ops.ts); invalid values are
 *   dropped (the default then applies), never replaced.
 */
import { formatStops, isHex, parseStops } from "./color";
import { isOpKind, OP_DEFS } from "./ops";
import { MAX_NAME, MAX_OPS, RECIPE_VERSION, type GradeAnim, type GradeOp, type GradeParam, type GradeRecipe, type GradeTier, type Region, type WildCurve } from "./types";

export type RecipeResult = { ok: true; recipe: GradeRecipe } | { ok: false; error: string };

const TIERS: readonly GradeTier[] = ["film", "bold", "bonkers", "mine", "ai"];
const CURVES: readonly WildCurve[] = ["linear", "late", "early"];
const WAVES = ["sine", "saw", "beat", "bar"] as const;
const ID = /^[A-Za-z0-9_-]{1,6}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function clampRegion(raw: unknown): Region {
  if (!isObj(raw)) return { kind: "all" };
  const unit = (v: unknown, def: number) => (finite(v) ? clamp(v, 0, 1) : def);
  switch (raw.kind) {
    case "highlights":
    case "shadows":
    case "midtones":
      return { kind: raw.kind, soft: unit(raw.soft, 0.5) };
    case "subject":
    case "background":
    case "people": {
      const r: Region = { kind: raw.kind, feather: unit(raw.feather, 0.2) };
      if (raw.invert === true) r.invert = true;
      return r;
    }
    case "near":
    case "far":
      return { kind: raw.kind, split: unit(raw.split, 0.5), feather: unit(raw.feather, 0.2) };
    default:
      return { kind: "all" };
  }
}

/** One param value clamped by its spec, or undefined when it can't be used. */
export function clampParam(spec: { kind: string; min?: number; max?: number; options?: readonly string[]; default: GradeParam }, v: unknown): GradeParam | undefined {
  const lo = spec.min ?? -Infinity;
  const hi = spec.max ?? Infinity;
  switch (spec.kind) {
    case "number":
      return finite(v) ? clamp(v, lo, hi) : undefined;
    case "color":
      return isHex(v) ? v.toLowerCase() : undefined;
    case "enum":
      return typeof v === "string" && (spec.options ?? []).includes(v) ? v : undefined;
    case "bool":
      return typeof v === "boolean" ? v : undefined;
    case "points":
    case "matrix": {
      const len = Array.isArray(spec.default) ? spec.default.length : 0;
      if (!Array.isArray(v) || v.length !== len || !v.every(finite)) return undefined;
      return v.map((x) => clamp(x as number, lo, hi));
    }
    case "stops": {
      const s = parseStops(v);
      return s ? formatStops(s) : undefined;
    }
    default:
      return undefined;
  }
}

function clampOp(raw: unknown): GradeOp | null {
  if (!isObj(raw)) return null;
  const kind = raw.kind;
  if (typeof kind !== "string" || !isOpKind(kind)) return null;
  const specs = OP_DEFS[kind].params;
  const params: Record<string, GradeParam> = {};
  if (isObj(raw.params)) {
    for (const [k, spec] of Object.entries(specs)) {
      if (!(k in raw.params)) continue;
      const v = clampParam(spec, raw.params[k]);
      if (v !== undefined) params[k] = v;
    }
  }
  const op: GradeOp = {
    id: typeof raw.id === "string" ? raw.id : "",
    kind,
    on: raw.on === false ? false : true,
    amount: finite(raw.amount) ? clamp(raw.amount, 0, 1) : 1,
    region: clampRegion(raw.region),
    params,
  };
  if (raw.chaos === true) op.chaos = true;
  if (isObj(raw.anim)) {
    const a = raw.anim;
    const anim: GradeAnim = {
      speed: finite(a.speed) ? clamp(a.speed, 0.05, 6) : 1,
      wave: (WAVES as readonly unknown[]).includes(a.wave) ? (a.wave as GradeAnim["wave"]) : "sine",
    };
    op.anim = anim;
  }
  return op;
}

/** Validates and clamps a recipe (any JSON value). */
export function validateRecipe(raw: unknown): RecipeResult {
  if (!isObj(raw)) return { ok: false, error: "The look isn't an object" };
  if (raw.v !== RECIPE_VERSION) return { ok: false, error: `Unknown look version ${String(raw.v)}` };
  if (!Array.isArray(raw.ops)) return { ok: false, error: "The look has no ops list" };
  const ops: GradeOp[] = [];
  const seen = new Set<string>();
  for (const r of raw.ops) {
    const op = clampOp(r);
    if (!op) continue;
    if (!ID.test(op.id)) return { ok: false, error: `Op id "${op.id}" must be 1 to 6 letters or digits` };
    if (seen.has(op.id)) return { ok: false, error: `Two ops share the id ${op.id}` };
    seen.add(op.id);
    if (ops.length < MAX_OPS) ops.push(op);
  }
  const name = Array.from(typeof raw.name === "string" ? raw.name.trim() : "")
    .slice(0, MAX_NAME)
    .join("")
    .trim();
  const seed = finite(raw.seed) ? Math.max(0, Math.min(4294967295, Math.floor(raw.seed))) : 0;
  return {
    ok: true,
    recipe: {
      v: 1,
      name: name || "Untitled",
      tier: (TIERS as readonly unknown[]).includes(raw.tier) ? (raw.tier as GradeTier) : "ai",
      seed,
      wildCurve: (CURVES as readonly unknown[]).includes(raw.wildCurve) ? (raw.wildCurve as WildCurve) : "linear",
      ops,
    },
  };
}

/** Parses a recipe's JSON text and validates it. */
export function parseRecipe(json: string): RecipeResult {
  try {
    return validateRecipe(JSON.parse(json));
  } catch (e) {
    return { ok: false, error: `The look couldn't be read: ${String(e)}` };
  }
}

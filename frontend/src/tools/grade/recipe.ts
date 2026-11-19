/**
 * Recipe helpers of the Color Grader tool (Phase 21 SPEC §E1): conversions
 * between the service's `Recipe` (bindings) and the engine's `GradeRecipe`,
 * and the pure edits the Look panel and Chaos make on one. Nothing here
 * touches React or the services.
 */
import type { GradeServiceRecipe } from "@/lib/api";
import { opDef } from "@/grade/ops";
import {
  CHAOS_ABOVE,
  GRADE_OP_KINDS,
  MAX_NAME,
  MAX_OPS,
  RECIPE_VERSION,
  type GradeAnim,
  type GradeOp,
  type GradeOpKind,
  type GradeParam,
  type GradeRecipe,
  type GradeTier,
  type Region,
} from "@/grade/types";

const TIERS: readonly GradeTier[] = ["film", "bold", "bonkers", "mine", "ai"];
const KINDS: ReadonlySet<string> = new Set(GRADE_OP_KINDS);

type ServiceOp = NonNullable<GradeServiceRecipe["ops"]>[number];
type ServiceRegion = ServiceOp["region"];

export function regionFromService(r: ServiceRegion | undefined): Region {
  switch (r?.kind) {
    case "highlights":
    case "shadows":
    case "midtones":
      return { kind: r.kind, soft: r.soft ?? 0.3 };
    case "subject":
    case "background":
    case "people":
      return { kind: r.kind, feather: r.feather ?? 0.2, ...(r.invert ? { invert: true } : {}) };
    case "near":
    case "far":
      return { kind: r.kind, split: r.split ?? 0.5, feather: r.feather ?? 0.2 };
    default:
      return { kind: "all" };
  }
}

export function regionToService(r: Region): ServiceRegion {
  return { ...r } as ServiceRegion;
}

export function fromService(r: GradeServiceRecipe): GradeRecipe {
  const ops: GradeOp[] = [];
  for (const o of r.ops ?? []) {
    if (!KINDS.has(o.kind)) continue;
    const op: GradeOp = {
      id: o.id,
      kind: o.kind as GradeOpKind,
      on: o.on,
      amount: o.amount,
      region: regionFromService(o.region),
      params: { ...((o.params ?? {}) as Record<string, GradeParam>) },
    };
    if (o.chaos) op.chaos = true;
    if (o.anim) op.anim = { speed: o.anim.speed, wave: o.anim.wave as GradeAnim["wave"] };
    ops.push(op);
  }
  const tier = (TIERS as readonly string[]).includes(r.tier) ? (r.tier as GradeTier) : "mine";
  const curve = r.wildCurve === "late" || r.wildCurve === "early" ? r.wildCurve : "linear";
  return { v: RECIPE_VERSION, name: r.name, tier, seed: r.seed, wildCurve: curve, ops };
}

export function toService(r: GradeRecipe): GradeServiceRecipe {
  return {
    v: RECIPE_VERSION,
    name: r.name,
    tier: r.tier as GradeServiceRecipe["tier"],
    seed: r.seed,
    wildCurve: r.wildCurve,
    ops: r.ops.map((o) => ({
      id: o.id,
      kind: o.kind,
      on: o.on,
      ...(o.chaos ? { chaos: true } : {}),
      amount: o.amount,
      region: regionToService(o.region),
      params: { ...o.params },
      ...(o.anim ? { anim: { ...o.anim } } : {}),
    })),
  };
}

/** A recipe the AI wrote. */
export function asAi(r: GradeRecipe): GradeRecipe {
  return { ...r, tier: "ai" };
}

/** The empty look: no ops, so the picture is unchanged. */
export function emptyRecipe(name = "Untitled look"): GradeRecipe {
  return { v: RECIPE_VERSION, name, tier: "mine", seed: 0, wildCurve: "linear", ops: [] };
}

// ---- wildness ----

export const WILD_STOPS = [
  { value: 0, label: "Tasteful" },
  { value: 0.5, label: "Bold" },
  { value: 1, label: "Bonkers" },
] as const;

export const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** The name of the stop Wildness is nearest to. */
export function wildLabel(w: number): string {
  const v = clamp01(w);
  return v < 0.25 ? "Tasteful" : v < 0.75 ? "Bold" : "Bonkers";
}

/** Whether the look's chaos ops are on at this Wildness. */
export const chaosOn = (w: number): boolean => w > CHAOS_ABOVE;

// ---- ops ----

/** A 6-character op id not in `taken`; `rand` returns 0..1 (default Math.random: the UI's, Chaos passes its seeded one). */
export function newOpId(taken: ReadonlySet<string>, rand: () => number = Math.random): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let tries = 0; tries < 50; tries++) {
    let id = "";
    for (let i = 0; i < 6; i++) id += abc.charAt(Math.floor(rand() * abc.length) % abc.length);
    if (!taken.has(id)) return id;
  }
  return `x${taken.size.toString(36).padStart(5, "0")}`.slice(0, 6);
}

export function opLabel(kind: GradeOpKind): string {
  return opDef(kind)?.label ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** The catalog default of every param of a kind. */
export function defaultParams(kind: GradeOpKind): Record<string, GradeParam> {
  const out: Record<string, GradeParam> = {};
  for (const [k, spec] of Object.entries(opDef(kind)?.params ?? {})) out[k] = Array.isArray(spec.default) ? [...spec.default] : spec.default;
  return out;
}

export function newOp(kind: GradeOpKind, taken: ReadonlySet<string>, rand?: () => number): GradeOp {
  return { id: newOpId(taken, rand), kind, on: true, amount: 1, region: { kind: "all" }, params: defaultParams(kind) };
}

export function addOp(r: GradeRecipe, kind: GradeOpKind): GradeRecipe {
  if (r.ops.length >= MAX_OPS) return r;
  const op = newOp(kind, new Set(r.ops.map((o) => o.id)));
  return { ...r, ops: [...r.ops, op] };
}

export function patchOp(r: GradeRecipe, id: string, patch: Partial<Omit<GradeOp, "id" | "kind">>): GradeRecipe {
  if (!r.ops.some((o) => o.id === id)) return r;
  return { ...r, ops: r.ops.map((o) => (o.id === id ? { ...o, ...patch } : o)) };
}

export function patchParam(r: GradeRecipe, id: string, key: string, value: GradeParam): GradeRecipe {
  const op = r.ops.find((o) => o.id === id);
  if (!op) return r;
  return patchOp(r, id, { params: { ...op.params, [key]: value } });
}

export function removeOp(r: GradeRecipe, id: string): GradeRecipe {
  return { ...r, ops: r.ops.filter((o) => o.id !== id) };
}

/** Moves an op from one index to another (clamped). */
export function moveOp(r: GradeRecipe, from: number, to: number): GradeRecipe {
  if (from < 0 || from >= r.ops.length) return r;
  const target = Math.min(r.ops.length - 1, Math.max(0, to));
  if (target === from) return r;
  const ops = [...r.ops];
  const [op] = ops.splice(from, 1);
  if (!op) return r;
  ops.splice(target, 0, op);
  return { ...r, ops };
}

export function rename(r: GradeRecipe, name: string): GradeRecipe {
  return { ...r, name: name.slice(0, MAX_NAME) };
}

export function regionLabel(r: Region): string {
  switch (r.kind) {
    case "all":
      return "Everywhere";
    case "highlights":
      return "Highlights";
    case "shadows":
      return "Shadows";
    case "midtones":
      return "Midtones";
    case "subject":
      return r.invert ? "Not the subject" : "Subject";
    case "background":
      return r.invert ? "Not the background" : "Background";
    case "people":
      return r.invert ? "Not people" : "People";
    case "near":
      return "Near";
    case "far":
      return "Far";
  }
}

export const REGION_KINDS: ReadonlyArray<{ kind: Region["kind"]; label: string; needs?: "depth" | "subject" | "people" }> = [
  { kind: "all", label: "Everywhere" },
  { kind: "highlights", label: "Highlights" },
  { kind: "midtones", label: "Midtones" },
  { kind: "shadows", label: "Shadows" },
  { kind: "subject", label: "Subject", needs: "subject" },
  { kind: "background", label: "Background", needs: "subject" },
  { kind: "people", label: "People", needs: "people" },
  { kind: "near", label: "Near", needs: "depth" },
  { kind: "far", label: "Far", needs: "depth" },
];

/** A region of another kind with that kind's default softness. */
export function regionOfKind(kind: Region["kind"]): Region {
  switch (kind) {
    case "highlights":
    case "shadows":
    case "midtones":
      return { kind, soft: 0.3 };
    case "subject":
    case "background":
    case "people":
      return { kind, feather: 0.2 };
    case "near":
    case "far":
      return { kind, split: 0.5, feather: 0.2 };
    default:
      return { kind: "all" };
  }
}

/** Which region map a region needs. */
export function regionNeeds(r: Region): "depth" | "subject" | "people" | null {
  switch (r.kind) {
    case "subject":
    case "background":
      return "subject";
    case "people":
      return "people";
    case "near":
    case "far":
      return "depth";
    default:
      return null;
  }
}

/** The maps a recipe's regions and ops need that the input doesn't have. */
export function missingMaps(r: GradeRecipe, aux: { depth: boolean; subject: boolean; people: boolean }): Array<"depth" | "subject" | "people"> {
  const need = new Set<"depth" | "subject" | "people">();
  for (const o of r.ops) {
    if (!o.on) continue;
    const n = regionNeeds(o.region);
    if (n) need.add(n);
    for (const m of opDef(o.kind)?.needs ?? []) need.add(m);
  }
  return [...need].filter((m) => !aux[m]);
}

/** Which region maps exist, as the compiler wants them. */
export function mapReady(maps: { depth: { ready: boolean }; subject: { ready: boolean }; people: { ready: boolean } } | null): { depth: boolean; subject: boolean; people: boolean } {
  return { depth: !!maps?.depth.ready, subject: !!maps?.subject.ready, people: !!maps?.people.ready };
}

/** A one-line summary of what a recipe holds ("Teal & Orange · 5 ops"). */
export function recipeSummary(r: GradeRecipe): string {
  const n = r.ops.filter((o) => o.on).length;
  return `${r.name || "Untitled look"} · ${n} ${n === 1 ? "op" : "ops"}`;
}

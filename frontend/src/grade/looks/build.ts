/** Small builders the three look files share (ids are derived from the look id, so they never change). */
import { formatStops } from "../color";
import { defaultParams } from "../ops";
import type { BuiltInLook, GradeAnim, GradeOp, GradeOpKind, GradeParam, GradeRecipe, GradeTier, Region, WildCurve } from "../types";

/** FNV-1a, 32 bit. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

/** A stable 6-character op id. */
export function opId(lookId: string, index: number): string {
  return fnv(`${lookId}:${index}`).toString(36).padStart(6, "0").slice(-6);
}

export const R = {
  all: { kind: "all" } as Region,
  highlights: (soft = 0.5): Region => ({ kind: "highlights", soft }),
  shadows: (soft = 0.5): Region => ({ kind: "shadows", soft }),
  midtones: (soft = 0.5): Region => ({ kind: "midtones", soft }),
  subject: (feather = 0.25): Region => ({ kind: "subject", feather }),
  background: (feather = 0.25): Region => ({ kind: "background", feather }),
  people: (feather = 0.25): Region => ({ kind: "people", feather }),
  near: (split = 0.55, feather = 0.3): Region => ({ kind: "near", split, feather }),
  far: (split = 0.45, feather = 0.3): Region => ({ kind: "far", split, feather }),
};

/** A gradient string from [colour, position] pairs. */
export function grad(...stops: Array<[string, number]>): string {
  return formatStops(stops.map(([hex, pos]) => ({ hex, pos })));
}

export interface OpOpts {
  amount?: number;
  region?: Region;
  chaos?: boolean;
  anim?: GradeAnim;
  on?: boolean;
}

/** An op under construction: params are merged over the kind's defaults when the look is built. */
export interface OpSpec {
  kind: GradeOpKind;
  params: Record<string, GradeParam>;
  opts: OpOpts;
}

export const op = (kind: GradeOpKind, params: Record<string, GradeParam> = {}, opts: OpOpts = {}): OpSpec => ({ kind, params, opts });

export interface LookSpec {
  id: string;
  name: string;
  tier: GradeTier;
  curve?: WildCurve;
  blurb: string;
  ops: OpSpec[];
}

/** Builds a BuiltInLook: ids derived from the look id, every param explicit (defaults merged in). */
export function look(s: LookSpec): BuiltInLook {
  const ops: GradeOp[] = s.ops.map((o, i) => {
    const g: GradeOp = {
      id: opId(s.id, i),
      kind: o.kind,
      on: o.opts.on ?? true,
      amount: o.opts.amount ?? 1,
      region: o.opts.region ?? R.all,
      params: { ...defaultParams(o.kind), ...o.params },
    };
    if (o.opts.chaos) g.chaos = true;
    if (o.opts.anim) g.anim = o.opts.anim;
    return g;
  });
  const recipe: GradeRecipe = { v: 1, name: s.name, tier: s.tier, seed: fnv(s.id), wildCurve: s.curve ?? "linear", ops };
  return { id: s.id, recipe, blurb: s.blurb };
}

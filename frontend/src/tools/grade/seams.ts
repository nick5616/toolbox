/**
 * Where the tool meets the grade engine's optional pieces (Phase 21 G1 lands
 * them in parallel): the LUT baker (`grade/lut.ts`). Found by glob so the tool
 * builds without it; Export .cube says so when it's missing.
 */
import { opDef } from "@/grade/ops";
import type { GradeRecipe } from "@/grade/types";

export interface LutBake {
  /** size³ RGB floats 0..1, red fastest. */
  data: number[];
}

type BakeFn = (recipe: GradeRecipe, wild: number, size: number) => Promise<unknown> | unknown;

const lutModules = import.meta.glob<Record<string, unknown>>("../../grade/lut.ts", { eager: true });

let bakeOverride: BakeFn | null | undefined;
/** Tests set the baker (null = none). */
export function setLutBakerForTest(fn: BakeFn | null | undefined): void {
  bakeOverride = fn;
}

function findBaker(): BakeFn | null {
  if (bakeOverride !== undefined) return bakeOverride;
  for (const m of Object.values(lutModules)) {
    for (const name of ["bakeLut", "bakeCube", "bakeLUT", "bakeCubeLut"]) {
      const f = m[name];
      if (typeof f === "function") return f as BakeFn;
    }
  }
  return null;
}

export function lutAvailable(): boolean {
  return findBaker() !== null;
}

/** Bakes the recipe's colour-only ops at a Wildness into a size³ lattice. */
export async function bakeLut(recipe: GradeRecipe, wild: number, size = 33): Promise<LutBake> {
  const fn = findBaker();
  if (!fn) throw new Error("The LUT baker isn't available in this build");
  const out = await fn(recipe, wild, size);
  const raw = out && typeof out === "object" && !ArrayBuffer.isView(out) && !Array.isArray(out) ? ((out as { data?: unknown; floats?: unknown }).data ?? (out as { floats?: unknown }).floats) : out;
  const data = Array.isArray(raw) ? (raw as number[]) : ArrayBuffer.isView(raw) ? Array.from(raw as unknown as ArrayLike<number>) : [];
  if (data.length !== size * size * size * 3) throw new Error("The LUT came out the wrong size");
  return { data };
}

export interface LutLeftOut {
  /** Ops a LUT can't hold, by label and why. */
  ops: Array<{ id: string; reason: string }>;
}

/** What a LUT can't hold: ops with another region, texture/spatial ops, and motion. */
export function lutLeftOut(recipe: GradeRecipe): LutLeftOut {
  const ops: LutLeftOut["ops"] = [];
  for (const o of recipe.ops) {
    if (!o.on) continue;
    const def = opDef(o.kind);
    if (def && !def.colorOnly) ops.push({ id: o.id, reason: "texture" });
    else if (o.region.kind !== "all") ops.push({ id: o.id, reason: "region" });
    else if (o.anim) ops.push({ id: o.id, reason: "motion" });
  }
  return { ops };
}

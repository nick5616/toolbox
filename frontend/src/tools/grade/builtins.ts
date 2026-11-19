/**
 * The built-in looks, as the gallery and the step editor see them. They live
 * in `grade/looks/*.ts` (Phase 21 G1: one file per tier, each exporting
 * `BuiltInLook[]`); this file collects every such export without naming the
 * files, so the tool builds before and after they land.
 */
import type { BuiltInLook, GradeRecipe, GradeTier } from "@/grade/types";

const modules = import.meta.glob<Record<string, unknown>>(["../../grade/looks/*.ts", "!../../grade/looks/*.test.ts"], { eager: true });

function isLook(v: unknown): v is BuiltInLook {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const r = o.recipe as Record<string, unknown> | undefined;
  return typeof o.id === "string" && !!r && typeof r === "object" && Array.isArray(r.ops);
}

function collect(): BuiltInLook[] {
  const seen = new Set<string>();
  const out: BuiltInLook[] = [];
  const take = (v: unknown) => {
    const list = Array.isArray(v) ? v : isLook(v) ? [v] : [];
    for (const l of list) {
      if (isLook(l) && !seen.has(l.id)) {
        seen.add(l.id);
        out.push(l);
      }
    }
  };
  for (const m of Object.values(modules)) for (const v of Object.values(m)) take(v);
  return out;
}

let override: BuiltInLook[] | null = null;
let cached: BuiltInLook[] | null = null;

/** Tests set the looks the gallery shows (null restores the real ones). */
export function setBuiltInLooksForTest(looks: BuiltInLook[] | null): void {
  override = looks;
}

export function builtInLooks(): BuiltInLook[] {
  if (override) return override;
  cached ??= collect();
  return cached;
}

export function builtInLook(id: string): BuiltInLook | undefined {
  return builtInLooks().find((l) => l.id === id);
}

/** The looks of one tier ("film" | "bold" | "bonkers"), in catalogue order. */
export function looksOfTier(tier: GradeTier): BuiltInLook[] {
  return builtInLooks().filter((l) => l.recipe.tier === tier);
}

/** A recipe's gallery key. Built-in looks use their id; others their name. */
export function lookKey(r: GradeRecipe, builtInId = ""): string {
  return builtInId || `${r.tier}:${r.name}`;
}

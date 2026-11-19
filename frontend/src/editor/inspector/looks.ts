/**
 * Color Grader looks as effect stacks (Phase 21 SPEC §E1 "Copy look for Video
 * Editor"): every built-in look and the user's saved looks, compiled with the
 * same `compileRecipe` the Color Grader exports with (at its default Bold
 * wildness, no region maps — the editor's clips have none), with fresh ids.
 */
import { newId } from "@/editor/doc";
import { BUILT_IN_LOOKS } from "@/grade/builtins";
import { compileRecipe } from "@/grade/compile";
import type { GradeRecipe } from "@/grade/types";
import { GradeService } from "@/lib/api";
import type { EditPost } from "@/viz/edit/types";

export const LOOKS_GROUP = "Looks";
export const SAVED_LOOKS_GROUP = "My looks";
export const LOOK_WILDNESS = 0.5;

export interface LookEntry {
  id: string;
  label: string;
  description: string;
  group: string;
  recipe: GradeRecipe;
}

/** Fresh effects for a look (new ids each time it's added). */
export function lookEffects(recipe: GradeRecipe, wild = LOOK_WILDNESS): EditPost[] {
  return compileRecipe(recipe, wild, { depth: false, subject: false, people: false }).map((p) => ({ ...p, id: newId("fx") }));
}

export function builtInLookEntries(): LookEntry[] {
  return BUILT_IN_LOOKS.map((l) => ({ id: `look:${l.id}`, label: l.recipe.name, description: l.blurb, group: LOOKS_GROUP, recipe: l.recipe }));
}

let saved: LookEntry[] = [];
let loading: Promise<LookEntry[]> | null = null;

/** The saved looks (fetched once per session, refreshed on each picker open). */
export function loadSavedLooks(): Promise<LookEntry[]> {
  loading ??= GradeService.Looks()
    .then((rs) =>
      (rs ?? []).map((r) => ({ id: `mine:${r.name}`, label: r.name, description: "A look you saved in Color Grader.", group: SAVED_LOOKS_GROUP, recipe: r as unknown as GradeRecipe })),
    )
    .catch(() => [] as LookEntry[])
    .then((list) => {
      saved = list;
      loading = null;
      return list;
    });
  return loading;
}

export function savedLookEntries(): LookEntry[] {
  return saved;
}

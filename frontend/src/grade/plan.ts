/**
 * Applying a render plan's `grade` (core/viz.GradePlan: a recipe JSON and a wildness) to an edit project
 * (Phase 21 §E3.5, §E4): the host compiles the recipe with the same `compileRecipe` as the preview and puts the
 * effects on the project's first picture clip, so the Color Grader's exports match its preview. Used by the
 * still path (viz/edit/headless.ts) and the video path (viz/edit/worker.ts).
 */
import type { EditProject } from "@/lib/api";
import { clipAuxOf, type ClipAux } from "@/viz/edit/clipAux";
import type { EditFiles, EditPost } from "@/viz/edit/types";
import { compileRecipe } from "./compile";
import { parseRecipe } from "./validate";

export interface GradePlanJson {
  recipeJson: string;
  wild: number;
}

export interface AppliedGrade {
  project: EditProject;
  /** The maps the graded clip carries (for binding them while it renders). */
  aux: ClipAux;
  /** The posts that were added. */
  posts: EditPost[];
}

function parseEffects(json: string | undefined | null): EditPost[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as EditPost[]) : [];
  } catch {
    return [];
  }
}

/** Returns a copy of the project whose first video/image clip has the compiled look added to its effects. Throws a readable Error for a bad recipe. */
export function applyGradePlan(project: EditProject, grade: GradePlanJson, files: Pick<EditFiles, "streams" | "images">): AppliedGrade {
  const parsed = parseRecipe(grade.recipeJson);
  if (!parsed.ok) throw new Error(parsed.error);
  const tracks = (project.tracks ?? []).map((t) => ({ ...t, clips: (t.clips ?? []).map((c) => ({ ...c })) }));
  for (const t of tracks) {
    for (const c of t.clips) {
      if (c.kind !== "video" && c.kind !== "image") continue;
      const aux = clipAuxOf({ depth: c.depth ?? null, matte: c.matte ? { id: c.matte.id, mode: c.matte.mode } : null }, files);
      const posts = compileRecipe(parsed.recipe, grade.wild, { depth: !!aux.depth, subject: !!aux.subject, people: !!aux.people });
      c.effects = JSON.stringify([...parseEffects(c.effects), ...posts]);
      return { project: { ...project, tracks }, aux, posts };
    }
  }
  throw new Error("The edit has no picture to grade");
}

/**
 * compileRecipe (Phase 21 SPEC §E3.2): a look at a Wildness → the editor
 * effects that draw it. Pure and golden-tested; the Color Grader preview, its
 * exports (the render host compiles plan.grade with it), the pipeline step
 * and the Video Editor's Looks menu all use it. G1 implements it.
 */
import type { EditPost } from "@/viz/edit/types";
import type { GradeAuxState, GradeRecipe } from "./types";

export function compileRecipe(_recipe: GradeRecipe, _wild: number, _aux: GradeAuxState): EditPost[] {
  return [];
}

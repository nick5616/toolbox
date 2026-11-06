/**
 * Auto-fill contracts (Phase 9 SPEC §13.1). CONTRACT (Wave 0): frozen.
 * WP-ES6 implements `autofill` (./autofill.ts) and the presets (./recipes.ts).
 */
import type { EditClip } from "@/lib/api";
import type { Analysis } from "@/viz/analysis";
import type { NormalProject } from "@/viz/edit/defaults";
import type { EditPost, EditTransition, Marker, MarkerLane } from "@/viz/edit/types";
import type { SectionLabel } from "@/viz/types";

export interface RecipeRule {
  /** Applies inside these sections; omitted = anywhere not taken by an earlier rule. */
  sections?: SectionLabel[];
  /** Cut points. */
  cutLane: MarkerLane;
  /** Every Nth marker of that lane (after the lane's own filters), default 1. */
  every?: number;
  /** Merge cuts closer than this (drop the later cut), default 250. */
  minClipMs?: number;
  sourceOrder: "sequential" | "shuffleNoRepeat" | "byTag";
  /** byTag (and a preference for the others). */
  tags?: string[];
  videoIn: "start" | "random" | "shotAligned";
  /** Added to every clip this rule makes. */
  effects?: EditPost[];
  /** Into every clip this rule makes (default cut). */
  transition?: EditTransition;
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  /** First matching rule wins per section. */
  rules: RecipeRule[];
  onDrop?: { tag?: string; effects: EditPost[]; transition?: EditTransition };
  onStop?: "freeze" | "black" | "none";
}

export interface AutofillOptions {
  recipeId: string;
  seed: number;
  /** "recipe" = each rule's own. */
  order: "recipe" | "sequential" | "shuffleNoRepeat" | "byTag";
  /** Explicit paths come from the Sources panel selection. */
  sources: "all" | "selected" | string[];
  /** Target video track; "new" adds "Auto" on top. */
  trackId: string;
  /** Timeline ms; null = whole edit. */
  range: { fromMs: number; toMs: number } | null;
}

export interface AutofillSource {
  path: string;
  kind: "video" | "image";
  durationMs: number;
  tags: string[];
  /** Shot boundaries (source ms), null = not made. */
  shots: number[] | null;
}

export interface AutofillInput {
  project: NormalProject;
  markers: Marker[];
  analysis: Analysis;
  sources: AutofillSource[];
  recipe: Recipe;
  options: AutofillOptions;
}

export interface AutofillResult {
  trackId: string;
  clips: EditClip[];
  /** IDs of auto clips that were removed. */
  removed: string[];
  warnings: string[];
}

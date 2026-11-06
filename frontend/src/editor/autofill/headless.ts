/**
 * Headless auto-fill (Phase 14 A2, "Cut to the beat"). A pipeline step has an
 * edit with a song, its analysis and some clips, and wants the recipe's cuts
 * without any tool open. The render host calls `fillWithRecipe`, and Go renders
 * the filled edit with the normal export. Pure and deterministic: the same
 * inputs and seed give the same edit.
 */
import type { EditProject } from "@/lib/api";
import type { Analysis } from "@/viz/analysis";
import { normalizeProject } from "@/viz/edit/defaults";
import { deriveMarkers } from "@/viz/edit/markers";
import { editLength } from "@/viz/edit/types";
import { RenderError } from "@/viz/worker/transport";
import { autofill, validateShape } from "./autofill";
import { RECIPES } from "./recipes";
import type { AutofillOptions, AutofillSource } from "./types";

/** What Go asks for (core/viz.RecipePlan). */
export interface RecipeRequest {
  projectJson: string;
  recipeId: string;
  seed: number;
  order: AutofillOptions["order"];
  sources: Array<{ path: string; kind: string; durationMs: number; tags: string[] | null; shots: number[] | null }>;
}

/** The edit with the recipe's clips on its first unlocked video track. */
export function fillWithRecipe(req: RecipeRequest, analysis: Analysis): EditProject {
  let raw: unknown;
  try {
    raw = JSON.parse(req.projectJson);
  } catch (e) {
    throw new RenderError("The edit couldn't be read", String(e));
  }
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { tracks?: unknown }).tracks)) throw new RenderError("The edit couldn't be read", "no tracks");
  const project = normalizeProject(raw as EditProject);
  if (!project.song) throw new RenderError("The edit has no song", "");
  const recipe = RECIPES.find((r) => r.id === req.recipeId);
  if (!recipe) throw new RenderError("Unknown cutting style", req.recipeId);
  const track = project.tracks.find((t) => t.kind === "video" && !t.locked);
  if (!track) throw new RenderError("The edit has no video track", "");

  const sources: AutofillSource[] = [];
  for (const s of req.sources) {
    if (s.kind !== "video" && s.kind !== "image") continue;
    sources.push({ path: s.path, kind: s.kind, durationMs: s.durationMs, tags: s.tags ?? [], shots: s.shots });
  }
  const markers = deriveMarkers(analysis, project.markers, { startMs: project.song.startMs, endMs: project.song.endMs });
  const options: AutofillOptions = { recipeId: recipe.id, seed: req.seed, order: req.order, sources: "all", trackId: track.id, range: null };
  const res = autofill({ project, markers, analysis, sources, recipe, options });
  if (res.clips.length === 0) throw new RenderError("The cutting style made no cuts", res.warnings.join("; "));

  const gone = new Set(res.removed);
  const clips = [...track.clips.filter((c) => !gone.has(c.id)), ...res.clips].sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
  const bad = validateShape(clips, new Set(res.clips.map((c) => c.id)), editLength(project));
  if (bad) throw new RenderError("The cutting style made an invalid layout", bad);
  return {
    ...project,
    tracks: project.tracks.map((t) => (t.id === track.id ? { ...t, clips } : t)),
    recipe: { recipeId: recipe.id, seed: req.seed, run: 1, options: JSON.stringify(options) },
  };
}

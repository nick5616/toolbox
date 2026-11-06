import { describe, expect, it } from "vitest";
import { normalizeProject } from "@/viz/edit/defaults";
import { buildEditFixture, fixtureProject } from "@/viz/edit/fixture";
import { RenderError } from "@/viz/worker/transport";
import { RECIPES } from "./recipes";
import { fillWithRecipe, type RecipeRequest } from "./headless";

const analysis = buildEditFixture();

function request(over: Partial<RecipeRequest> = {}): RecipeRequest {
  const p = normalizeProject(fixtureProject());
  const base = { ...p, tracks: [{ ...p.tracks[0]!, clips: [] }, ...p.tracks.slice(1)] };
  return {
    projectJson: JSON.stringify(base),
    recipeId: "downbeat",
    seed: 1,
    order: "recipe",
    sources: [
      { path: "/a.mp4", kind: "video", durationMs: 10_000, tags: ["hero"], shots: null },
      { path: "/b.mp4", kind: "video", durationMs: 10_000, tags: null, shots: [0, 3000] },
      { path: "/c.jpg", kind: "image", durationMs: 0, tags: [], shots: null },
    ],
    ...over,
  };
}

describe("fillWithRecipe", () => {
  it("fills the first video track with the recipe's cuts", () => {
    const out = fillWithRecipe(request(), analysis);
    const track = out.tracks?.find((t) => t.kind === "video");
    const clips = track?.clips ?? [];
    expect(clips.length).toBeGreaterThan(8);
    // downbeat cuts: one per bar (2 s), the first at 0
    expect(clips[0]?.startMs).toBe(0);
    expect(clips[1]?.startMs).toBe(2000);
    expect(clips.every((c) => c.auto && (c.path === "/a.mp4" || c.path === "/b.mp4" || c.path === "/c.jpg"))).toBe(true);
    expect(out.recipe?.recipeId).toBe("downbeat");
    expect(JSON.parse(out.recipe?.options ?? "{}")).toMatchObject({ recipeId: "downbeat", seed: 1, trackId: track?.id });
    // other tracks, the song and the analysis key stay
    expect(out.song).toEqual(fixtureProject().song);
    expect(out.tracks?.length).toBe(fixtureProject().tracks?.length);
  });

  it("is deterministic and seed-dependent", () => {
    const a = JSON.stringify(fillWithRecipe(request({ recipeId: "kick", seed: 5 }), analysis));
    const b = JSON.stringify(fillWithRecipe(request({ recipeId: "kick", seed: 5 }), analysis));
    const c = JSON.stringify(fillWithRecipe(request({ recipeId: "kick", seed: 6 }), analysis));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("can run every recipe the step offers", () => {
    for (const id of ["downbeat", "kick", "chorus-double", "hold-verse", "drop-slam", "anime-drop"]) {
      expect(RECIPES.some((r) => r.id === id), id).toBe(true);
      expect(fillWithRecipe(request({ recipeId: id }), analysis).tracks?.[0]?.clips?.length, id).toBeGreaterThan(0);
    }
  });

  it("explains what went wrong as RenderErrors", () => {
    expect(() => fillWithRecipe(request({ recipeId: "nope" }), analysis)).toThrow(RenderError);
    expect(() => fillWithRecipe(request({ projectJson: "{" }), analysis)).toThrow(RenderError);
    expect(() => fillWithRecipe(request({ sources: [] }), analysis)).toThrow(/no cuts/);
    const noSong = { ...JSON.parse(request().projectJson), song: null };
    expect(() => fillWithRecipe(request({ projectJson: JSON.stringify(noSong) }), analysis)).toThrow(/no song/);
  });
});

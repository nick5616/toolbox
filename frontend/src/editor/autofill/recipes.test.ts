import { describe, expect, it } from "vitest";
import type { EditClip } from "@/lib/api";
import { normalizeProject, type NormalProject } from "@/viz/edit/defaults";
import { buildEditFixture, fixtureKicks, fixtureProject } from "@/viz/edit/fixture";
import { parseEffects } from "@/viz/edit/schema";
import type { Marker, MarkerLane } from "@/viz/edit/types";
import { autofill } from "./autofill";
import { RECIPES } from "./recipes";
import type { AutofillInput, AutofillOptions, AutofillSource } from "./types";

const analysis = buildEditFixture();
const mk = (lane: MarkerLane, ms: number, extra: Partial<Marker> = {}): Marker => ({ id: `${lane}:${ms}`, lane, ms, strength: 1, ...extra });

function markers(): Marker[] {
  const out: Marker[] = [];
  for (let t = 0; t < 24_000; t += 500) out.push(mk("beat", t));
  for (let t = 0; t < 24_000; t += 2000) out.push(mk("downbeat", t));
  for (const t of fixtureKicks()) out.push(mk("kick", t));
  out.push(mk("stop", 15_000, { endMs: 15_400 }));
  out.push(mk("drop", 16_000));
  for (const s of analysis.audio.sections) out.push(mk("section", s.startMs, { endMs: s.endMs, label: s.label }));
  return out;
}

const SOURCES: AutofillSource[] = [
  { path: "/a.mp4", kind: "video", durationMs: 10_000, tags: ["hero"], shots: null },
  { path: "/b.mp4", kind: "video", durationMs: 10_000, tags: ["broll"], shots: null },
  { path: "/c.mp4", kind: "video", durationMs: 10_000, tags: ["broll"], shots: null },
];

function run(id: string, seed = 1) {
  const p: NormalProject = normalizeProject(fixtureProject());
  const options: AutofillOptions = { recipeId: id, seed, order: "recipe", sources: "all", trackId: "t1", range: null };
  const recipe = RECIPES.find((r) => r.id === id);
  if (!recipe) throw new Error(id);
  const input: AutofillInput = { project: { ...p, tracks: [{ ...p.tracks[0]!, clips: [] }, ...p.tracks.slice(1)] }, markers: markers(), analysis, sources: SOURCES, recipe, options };
  return autofill(input);
}

const cuts = (clips: EditClip[]) => clips.map((c) => c.startMs);
const range = (from: number, to: number, step: number) => {
  const out: number[] = [];
  for (let t = from; t < to; t += step) out.push(t);
  return out;
};
const types = (c: EditClip | undefined) => parseEffects(c?.effects ?? "").value.map((e) => e.type);

describe("Part B recipes", () => {
  it("are listed after the original five", () => {
    expect(RECIPES.map((r) => r.id).slice(-2)).toEqual(["anime-drop", "velocity-edit"]);
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(RECIPES.length);
  });

  it("Anime drop: bar cuts before the drop, kick cuts with the Anime hit stack in it", () => {
    const r = run("anime-drop");
    expect(r.warnings).toEqual([]);
    expect(cuts(r.clips)).toEqual([...range(0, 16_000, 2000), ...fixtureKicks().filter((t) => t >= 16_000)]);
    // verse and others: no effects
    expect(types(r.clips.find((c) => c.startMs === 4000))).toEqual([]);
    // the drop clip: Anime hit + shockwave + flash
    const dropClip = r.clips.find((c) => c.startMs === 16_000);
    expect(types(dropClip)).toEqual(["shake", "punch", "chromatic", "flash", "shockwave", "flash"]);
    // other drop-section kick clips: the Anime hit stack only
    expect(types(r.clips.find((c) => c.startMs === 16_500))).toEqual(["shake", "punch", "chromatic", "flash"]);
    // marker reactions survive on the clip
    const punch = parseEffects(dropClip?.effects ?? "").value.find((e) => e.type === "punch");
    expect(punch?.params.amount).toMatchObject({ base: 0, mods: [{ signal: "marker.kick", shape: "exp" }] });
    // effect IDs are unique within a clip
    const ids = parseEffects(dropClip?.effects ?? "").value.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("Anime drop is deterministic for a seed", () => {
    expect(run("anime-drop", 3)).toEqual(run("anime-drop", 3));
  });

  it("Velocity edit: a cut on every beat, each with punch and motion blur on the kicks", () => {
    const r = run("velocity-edit");
    expect(cuts(r.clips)).toEqual(range(0, 24_000, 500));
    for (const c of r.clips) {
      expect(types(c)).toEqual(["punch", "dirblur"]);
      expect(c.speed).toBe("");
    }
    const fx = parseEffects(r.clips[0]?.effects ?? "").value;
    expect(fx[1]?.params.amount).toMatchObject({ mods: [{ signal: "marker.kick" }] });
  });
});

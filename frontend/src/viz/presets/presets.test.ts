import { describe, expect, it } from "vitest";
import { buildFixture } from "../fixture";
import "../layers";
import { layerDef } from "../layers/registry";
import "../post";
import { postDef } from "../post/registry";
import { SIGNAL_META } from "../signals";
import { LAYER_TYPES, MAX_LAYERS_PER_SCENE, POST_TYPES, type Param, type PostConfig, type Show } from "../types";
import { validateShow } from "../validate";
import { autoTimeline } from "../director";
import { PRESETS, presetById, showFromPreset } from "./index";

const IDS = [
  "golden-hour", "neon-highway", "nebula", "synthwave", "spectrum-classic", "radial-pulse", "silk-waves", "warp-drive", "kaleido-bloom", "ink-water",
  "particle-storm", "aurora-curtains", "tunnel-run", "night-terrain", "oscilloscope-lab", "vortex", "lyric-stage", "mood-field", "clean-captions", "frame-pulse",
];

function modsOf(p: Param | string | boolean | undefined): Array<{ signal: string }> {
  return typeof p === "object" && p !== null ? p.mods : [];
}

/** Every Param in a show (layer opacity and params, post params) with a label for messages. */
function allParams(show: Show): Array<{ where: string; param: Param | string | boolean }> {
  const out: Array<{ where: string; param: Param | string | boolean }> = [];
  const post = (where: string, list: PostConfig[]) => {
    for (const pc of list) for (const [k, v] of Object.entries(pc.params)) out.push({ where: `${where}/${pc.id}.${k}`, param: v });
  };
  for (const sc of show.scenes) {
    for (const l of sc.layers) {
      out.push({ where: `${sc.id}/${l.id}.opacity`, param: l.opacity });
      for (const [k, v] of Object.entries(l.params)) out.push({ where: `${sc.id}/${l.id}.${k}`, param: v });
    }
    post(sc.id, sc.post);
  }
  post("global", show.post);
  return out;
}

/** Resolves a Reactions target to the numeric ParamSpecs it points at (one per scene or post effect). */
function resolveTarget(show: Show, target: string): Array<{ min: number; max: number } | null> {
  const parts = target.split(".");
  if (parts[0] === "post") {
    const [, id, param] = parts;
    const lists = [show.post, ...show.scenes.map((s) => s.post)];
    const found = lists.flatMap((l) => l.filter((p) => p.id === id));
    return found.map((p) => {
      const spec = postDef(p.type)?.params[param ?? ""];
      return spec?.kind === "number" ? spec : null;
    });
  }
  const [layerId, param] = parts;
  const found = show.scenes.flatMap((s) => s.layers.filter((l) => l.id === layerId));
  if (param === "opacity") return found.map(() => ({ min: 0, max: 1 }));
  return found.map((l) => {
    const spec = layerDef(l.type)?.params[param ?? ""];
    return spec?.kind === "number" ? spec : null;
  });
}

describe("presets", () => {
  it("has the 20 presets of the spec, in order, with unique ids", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(IDS);
    expect(new Set(PRESETS.map((p) => p.name)).size).toBe(20);
    expect(presetById("golden-hour")?.name).toBe("Golden Hour");
  });

  it.each(IDS)("%s validates and describes itself", (id) => {
    const p = presetById(id);
    if (!p) throw new Error(`missing ${id}`);
    const r = validateShow(JSON.stringify(p.show));
    expect(r.ok ? "ok" : r.problem).toBe("ok");
    expect(p.show.presetId).toBe(id);
    expect(p.description.length).toBeGreaterThan(20);
    expect(p.description.includes("\n")).toBe(false);
    expect(p.bestFor.length).toBeGreaterThan(3);
    expect(p.show.scenes.map((s) => s.id)).toEqual(["calm", "main", "full"]);
    for (const sc of p.show.scenes) expect(sc.layers.length).toBeLessThanOrEqual(MAX_LAYERS_PER_SCENE);
  });

  it.each(IDS)("%s only uses registered layers, post effects and signals", (id) => {
    const p = presetById(id) as (typeof PRESETS)[number];
    for (const sc of p.show.scenes) {
      for (const l of sc.layers) {
        expect(LAYER_TYPES as readonly string[]).toContain(l.type);
        expect(layerDef(l.type), `${id}/${sc.id}/${l.id}`).toBeDefined();
      }
      for (const pc of sc.post) expect(postDef(pc.type)).toBeDefined();
    }
    for (const pc of p.show.post) {
      expect(POST_TYPES as readonly string[]).toContain(pc.type);
      expect(postDef(pc.type)).toBeDefined();
    }
    for (const { where, param } of allParams(p.show)) {
      for (const mod of modsOf(param)) expect(SIGNAL_META.has(mod.signal as never), `${id} ${where} uses ${mod.signal}`).toBe(true);
    }
  });

  it.each(IDS)("%s has at least 3 reactions that point at real numeric parameters", (id) => {
    const p = presetById(id) as (typeof PRESETS)[number];
    expect(p.show.controls.length).toBeGreaterThanOrEqual(3);
    const labels = new Set<string>();
    for (const c of p.show.controls) {
      expect(c.label.trim().length).toBeGreaterThan(2);
      expect(labels.has(c.label), `${id}: duplicate label ${c.label}`).toBe(false);
      labels.add(c.label);
      const specs = resolveTarget(p.show, c.target);
      expect(specs.length, `${id}: ${c.target} matches nothing`).toBeGreaterThan(0);
      expect(
        specs.every((s) => s !== null),
        `${id}: ${c.target} is not numeric everywhere`,
      ).toBe(true);
    }
  });

  it.each(IDS)("%s shows a clear difference between its calm, main and full scenes", (id) => {
    const p = presetById(id) as (typeof PRESETS)[number];
    const sig = (idx: number) => JSON.stringify(p.show.scenes[idx]?.layers);
    expect(sig(0)).not.toBe(sig(1));
    expect(sig(1)).not.toBe(sig(2));
    // Full is never smaller than calm.
    expect((p.show.scenes[2]?.layers.length ?? 0) >= (p.show.scenes[0]?.layers.length ?? 0)).toBe(true);
  });

  it("every preset reacts to at least three different signals", () => {
    for (const p of PRESETS) {
      const used = new Set<string>();
      for (const { param } of allParams(p.show)) for (const mod of modsOf(param)) used.add(mod.signal);
      expect(used.size, `${p.id} uses ${[...used].join(", ")}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("picks text styles for presets and keeps overlay presets first", () => {
    expect(PRESETS.filter((p) => p.overlayFirst).map((p) => p.id)).toEqual(["clean-captions", "frame-pulse"]);
    expect(presetById("clean-captions")?.show.text?.preset).toBe("subtitle");
    expect(presetById("frame-pulse")?.show.text?.preset).toBe("karaoke");
    expect(presetById("lyric-stage")?.show.text?.preset).toBe("karaoke");
    expect((presetById("lyric-stage")?.show.text?.size ?? 0) >= 9).toBe(true);
    for (const p of PRESETS) if (p.id !== "spectrum-classic") expect(p.show.text, p.id).not.toBeNull();
  });

  it("wires the signature features", () => {
    const gh = presetById("golden-hour")?.show;
    expect(gh?.palette).toEqual({ mode: "journey", ids: ["deep-night", "dawn", "golden", "electric"] });
    const mood = presetById("mood-field")?.show;
    expect(mood?.palette.mode).toBe("mood");
    expect(mood?.motifs).toBe(true);
    expect(mood?.director?.follow).toBe("emotion");
    expect(presetById("ink-water")?.show.palette.mode).toBe("mood");
    expect(presetById("nebula")?.show.palette.mode).toBe("chords");
    expect(presetById("lyric-stage")?.show.scenes.every((s) => s.layers.some((l) => l.type === "image"))).toBe(true);
    for (const id of ["clean-captions", "frame-pulse"]) {
      const s = presetById(id)?.show;
      expect(s?.scenes.every((sc) => sc.layers.every((l) => layerDef(l.type)?.group !== "background" || l.id === "backdrop"))).toBe(true);
    }
  });

  it("copies shows so presets are never mutated", () => {
    const p = presetById("golden-hour") as (typeof PRESETS)[number];
    const a = showFromPreset(p);
    a.name = "changed";
    expect(p.show.name).toBe("Golden Hour");
  });

  it("builds an auto timeline for every preset on a fixture song", () => {
    const a = buildFixture({ durationMs: 60_000 });
    for (const p of PRESETS) {
      const tl = autoTimeline(a, showFromPreset(p));
      expect(tl.length, p.id).toBeGreaterThan(1);
      for (const e of tl) expect(p.show.scenes.some((s) => s.id === e.sceneId)).toBe(true);
    }
  });
});

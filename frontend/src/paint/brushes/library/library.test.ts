import { describe, expect, it } from "vitest";
import { BRUSH_SCHEMA_VERSION, type BrushPreset, type Curve, type Tip } from "../schema";
import manifest from "./manifest.json";
import { LIBRARY_PRESETS, OPEN_PRESETS, OWN_PRESETS, SET_NAMES, isLibraryRef, libraryPresetsIn, librarySetNames, resolveLibraryAsset } from "./index";

// SPEC 1.3.1: the set contents, in order.
const SPEC_SETS: Record<string, string[]> = {
  Sketching: ["HB", "6B", "Mechanical", "Charcoal stick", "Willow charcoal", "Conté", "Chalk"],
  Inking: ["Fine liner", "Technical pen", "Brush pen", "Dry ink", "Calligraphy (tilt)", "Marker", "Felt tip"],
  Painting: ["Soft round", "Hard round", "Gouache", "Oil (wet mix)", "Acrylic flat", "Impasto", "Watercolour", "Wash", "Glaze"],
  Airbrush: ["Soft", "Hard", "Grainy", "Spray can"],
  Nature: [
    "Leaf scatter (oak)", "Leaf scatter (maple)", "Leaf scatter (round)", "Leaf scatter (willow)",
    "Grass tufts", "Fern", "Pine needles", "Branch", "Bark", "Moss", "Petals",
    "Cloud billow", "Foam", "Rain", "Snow",
  ],
  Texture: ["Stipple", "Sponge", "Splatter", "Noise", "Crosshatch", "Halftone dots", "Canvas weave", "Paper fibre"],
  Elements: ["Fire", "Smoke", "Light flare", "Glow", "Stars"],
  Pixel: ["1 px", "Square", "Dither"],
  Erasers: ["Soft", "Hard", "Textured"],
  Smudge: ["Soft blend", "Rough blend", "Bristle"],
};

const num = (v: unknown, lo: number, hi: number, what: string) => {
  expect(typeof v, what).toBe("number");
  expect(Number.isFinite(v), what).toBe(true);
  expect(v as number, what).toBeGreaterThanOrEqual(lo);
  expect(v as number, what).toBeLessThanOrEqual(hi);
};

function checkCurve(c: Curve, what: string) {
  expect(Array.isArray(c) && c.length >= 2, what).toBe(true);
  let last = -1;
  for (const [x, y] of c) {
    num(x, 0, 1, what);
    num(y, 0, 1, what);
    expect(x, `${what}: sorted`).toBeGreaterThanOrEqual(last);
    last = x;
  }
}

function checkTip(t: Tip, what: string) {
  expect(typeof t.shape).toBe("string");
  num(t.hardness, 0, 1, `${what} hardness`);
  num(t.roundness, 0.05, 1, `${what} roundness`);
  num(t.angle, -360, 360, `${what} angle`);
  expect(["fixed", "stroke", "tilt"]).toContain(t.angleMode);
  num(t.rotationJitter, 0, 1, `${what} rotationJitter`);
  expect(typeof t.invert).toBe("boolean");
}

export function checkPreset(p: BrushPreset) {
  const w = p.id;
  expect(p.version).toBe(BRUSH_SCHEMA_VERSION);
  expect(p.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  expect(p.name.length).toBeGreaterThan(0);
  expect(p.set.length).toBeGreaterThan(0);
  num(p.size, 0.5, 1000, `${w} size`);
  num(p.minSize, 0, 1, `${w} minSize`);
  num(p.opacity, 0, 1, `${w} opacity`);
  num(p.flow, 0, 1, `${w} flow`);
  num(p.spacing, 0.01, 5, `${w} spacing`);
  num(p.scatter, 0, 3, `${w} scatter`);
  num(p.count, 1, 16, `${w} count`);
  num(p.taper.start, 0, 1, `${w} taper`);
  num(p.taper.end, 0, 1, `${w} taper`);
  checkTip(p.tip, `${w} tip`);
  if (p.dual) checkTip(p.dual, `${w} dual`);
  expect(["moving", "texturised"]).toContain(p.grain.mode);
  num(p.grain.scale, 0.1, 4, `${w} grain scale`);
  num(p.grain.depth, 0, 1, `${w} grain depth`);
  num(p.grain.contrast, 0, 2, `${w} grain contrast`);
  for (const dyn of p.dynamics) {
    expect(["pressure", "tilt", "velocity", "progress"]).toContain(dyn.input);
    expect(["size", "opacity", "flow", "scatter", "hue"]).toContain(dyn.target);
    num(dyn.amount, 0, 1, `${w} dynamics amount`);
    checkCurve(dyn.curve, `${w} dynamics curve`);
  }
  for (const k of ["hueJitter", "satJitter", "briJitter", "secondaryMix"] as const) num(p.color[k], 0, 1, `${w} color.${k}`);
  for (const k of ["mix", "dilution", "charge", "pull", "grade", "edges", "bleed"] as const) num(p.wet[k], 0, 1, `${w} wet.${k}`);
  expect(["light-glaze", "uniform-glaze", "intense", "heavy"]).toContain(p.rendering);
  num(p.impasto, 0, 1, `${w} impasto`);
  expect(["normal", "multiply", "screen", "add", "erase"]).toContain(p.blend);
  for (const k of ["streamline", "stabilisation", "motionFilter"] as const) num(p.smoothing[k], 0, 1, `${w} smoothing.${k}`);
  expect(typeof p.antialias).toBe("boolean");
  expect(Array.isArray(p.fidelity)).toBe(true);
}

describe("bundled brush library", () => {
  it("has at least 60 of our own brushes with the SPEC set names", () => {
    expect(OWN_PRESETS.length).toBeGreaterThanOrEqual(60);
    for (const [set, names] of Object.entries(SPEC_SETS)) {
      expect(OWN_PRESETS.filter((p) => p.set === set).map((p) => p.name), set).toEqual(names);
    }
    expect(OWN_PRESETS.length).toBe(Object.values(SPEC_SETS).flat().length);
  });

  it("has unique ids and valid schema fields", () => {
    const ids = new Set<string>();
    for (const p of LIBRARY_PRESETS) {
      expect(ids.has(p.id), `duplicate ${p.id}`).toBe(false);
      ids.add(p.id);
      checkPreset(p);
    }
  });

  it("makes every brush distinct", () => {
    const seen = new Set<string>();
    for (const p of OWN_PRESETS) {
      const key = JSON.stringify({ ...p, id: "", name: "" });
      expect(seen.has(key), `${p.id} duplicates another brush`).toBe(false);
      seen.add(key);
    }
  });

  it("resolves every lib: reference to a file that exists", () => {
    let refs = 0;
    for (const p of LIBRARY_PRESETS) {
      for (const ref of [p.tip.shape, p.dual?.shape ?? "", p.grain.texture]) {
        if (!isLibraryRef(ref)) continue;
        refs++;
        // the resolver only knows files that exist on disk (import.meta.glob)
        expect(resolveLibraryAsset(ref).length, `${p.id}: ${ref}`).toBeGreaterThan(0);
      }
    }
    expect(refs).toBeGreaterThan(40);
    expect(() => resolveLibraryAsset("lib:tips/nope.png")).toThrow();
  });

  it("keeps tips <= 256 px and grains 512 px, and lists them all in the manifest", () => {
    for (const t of manifest.tips) {
      expect(t.size).toBeLessThanOrEqual(256);
      expect(resolveLibraryAsset(t.file).length).toBeGreaterThan(0);
    }
    for (const g of manifest.grains) {
      expect(g.size).toBe(512);
      expect(resolveLibraryAsset(g.file).length).toBeGreaterThan(0);
    }
    expect(manifest.grains.length).toBeGreaterThanOrEqual(8);
    expect(manifest.tips.length).toBeGreaterThanOrEqual(20);
  });

  it("credits every open-licence brush", () => {
    expect(OPEN_PRESETS.length).toBeGreaterThanOrEqual(20);
    expect(librarySetNames().slice(0, 10)).toEqual([...SET_NAMES]);
    expect(librarySetNames().length).toBeGreaterThan(SET_NAMES.length);
    for (const p of OPEN_PRESETS) {
      expect(p.credit, p.id).not.toBe("");
      expect(p.license, p.id).toMatch(/^(CC0-1\.0|CC-BY-3\.0)$/);
    }
    for (const p of OWN_PRESETS) expect(p.credit).toBe("");
  });

  it("lists presets by set", () => {
    expect(libraryPresetsIn("Pixel").length).toBe(3);
  });
});

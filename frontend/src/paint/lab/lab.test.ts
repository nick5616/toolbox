import { describe, expect, it } from "vitest";
import { ALGORITHMIC_TOOLS, registerAll } from "./index";
import { CPU_POSTS } from "./cpu";
import { runPost } from "./adapter";
import { postDef } from "@/viz/post";
import { makeImage } from "./common";
import { curvePoints, createHarness, hashImage, nonEmpty, runStroke, testLayer } from "./testing";
import type { LabParams, LabTool } from "./types";
import type { PostLabTool } from "./adapter";

const byId = (id: string): LabTool => {
  const t = ALGORITHMIC_TOOLS.find((x) => x.id === id);
  if (!t) throw new Error(id);
  return t;
};

/** What a stroke leaves behind: the scratch pixels plus every dab, hashed. */
async function result(tool: LabTool, seed: number, params: LabParams = {}, chunk = 4, opts: { clearScratch?: boolean } = {}) {
  const defaults: LabParams = {};
  for (const p of tool.params) defaults[p.id] = p.default;
  const h = createHarness({ seed, params: { ...defaults, ...params }, clearScratch: opts.clearScratch });
  const steps = await runStroke(tool, h, curvePoints(), chunk);
  const dabs = h.dabs.map((d) => d.points.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.pressure.toFixed(3)}`).join(";")).join("|");
  return { hash: hashImage(h.scratch) + ":" + dabs.length + ":" + hashString(dabs), steps, h };
}
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

describe("Lab tool info", () => {
  it("lists every tool of SPEC 1.4.1 once", () => {
    const ids = ALGORITHMIC_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["flow-field", "growth", "reaction-diffusion", "ink-bleed", "particles", "pixel-sort", "smear", "feedback", "echo-trail", "voronoi-crackle", "kaleido", "mirror", "twirl", "bulge", "wave", "glitch", "chromatic", "vhs", "pixelate", "halftone", "posterize", "duotone"]) {
      expect(ids).toContain(id);
    }
  });

  it("registerAll hands every tool over", () => {
    const got: string[] = [];
    registerAll((t) => got.push(t.id));
    expect(got).toEqual(ALGORITHMIC_TOOLS.map((t) => t.id));
  });

  for (const t of ALGORITHMIC_TOOLS) {
    it(`${t.id} is fully described`, () => {
      expect(t.kind).toBe("algorithmic");
      expect(["exact", "seeded", "wild"]).toContain(t.predictability);
      expect(t.label.length).toBeGreaterThan(1);
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.icon).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(t.origin.kind).toBe("algorithm");
      if (t.origin.kind === "algorithm") expect(t.origin.text.length).toBeGreaterThan(40);
      expect(t.params.length).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const p of t.params) {
        expect(seen.has(p.id), `duplicate param ${p.id}`).toBe(false);
        seen.add(p.id);
        expect(p.tip.length, `${t.id}.${p.id} tip`).toBeGreaterThan(8);
        expect(p.label.length).toBeGreaterThan(0);
        if (p.type === "number") {
          expect(p.default).toBeGreaterThanOrEqual(p.min);
          expect(p.default).toBeLessThanOrEqual(p.max);
        }
        if (p.type === "choice") expect(p.choices.map((c) => c.value)).toContain(p.default);
      }
    });
  }
});

describe("determinism", () => {
  for (const t of ALGORITHMIC_TOOLS) {
    if (t.predictability === "wild") continue;
    it(`${t.id} gives the same result twice (${t.predictability})`, async () => {
      const a = await result(t, 7);
      const b = await result(t, 7);
      expect(a.hash).toBe(b.hash);
    });
    if (t.predictability === "exact") {
      it(`${t.id} ignores the seed`, async () => {
        expect((await result(t, 1)).hash).toBe((await result(t, 99)).hash);
      });
    }
  }

  for (const id of ["flow-field", "growth", "particles", "voronoi-crackle"]) {
    it(`${id} differs for different seeds`, async () => {
      const t = byId(id);
      const params: LabParams = id === "voronoi-crackle" ? { mode: "mud" } : {};
      expect((await result(t, 1, params)).hash).not.toBe((await result(t, 2, params)).hash);
    });
  }

  for (const id of ["flow-field", "growth", "echo-trail", "feedback", "smear", "pixel-sort", "twirl", "pixelate"]) {
    it(`${id} does not depend on how input is batched`, async () => {
      const t = byId(id);
      const params: LabParams = id === "twirl" ? { amount: 0.8 } : id === "pixelate" ? { amount: 0.8 } : {};
      const a = await result(t, 3, params, 1);
      const b = await result(t, 3, params, 7);
      // Echo's dabs are drawn per batch, so only its pixels are comparable.
      expect(id === "echo-trail" ? a.hash.split(":")[0] : a.hash).toBe(id === "echo-trail" ? b.hash.split(":")[0] : b.hash);
    });
  }
});

describe("tools paint something", () => {
  for (const t of ALGORITHMIC_TOOLS) {
    const post = (t as Partial<PostLabTool>).postType !== undefined;
    if (post && !(t as PostLabTool).cpu) continue; // GPU only
    it(`${t.id} leaves marks`, async () => {
      const params: LabParams = t.id === "twirl" || t.id === "bulge" || t.id === "wave" ? {} : {};
      const r = await result(t, 5, params);
      expect(nonEmpty(r.h.scratch) + r.h.dabs.length).toBeGreaterThan(0);
    });
  }
});

describe("simulations", () => {
  it("reaction-diffusion settles, in every pattern, within its duration", async () => {
    for (const preset of ["coral", "maze", "spots", "fingerprints"]) {
      const r = await result(byId("reaction-diffusion"), 1, { preset, ticks: 12, speed: 4 });
      expect(r.steps).toBeGreaterThan(0);
      expect(r.steps).toBeLessThanOrEqual(12);
      expect(nonEmpty(r.h.scratch)).toBeGreaterThan(0);
    }
  });

  it("reaction-diffusion can be stopped by the user (step is never needed again)", async () => {
    const t = byId("reaction-diffusion");
    const h = createHarness({ params: { preset: "coral", ticks: 400, speed: 2 } });
    const pts = curvePoints();
    t.onStrokeBegin(h.ctx, pts[0]!);
    t.onStrokeExtend(h.ctx, pts.slice(1));
    t.onStrokeEnd(h.ctx);
    expect(t.step!(h.ctx, 0)).toBe(true);
    expect(t.step!(h.ctx, 1)).toBe(true);
    // the engine stops calling; nothing else is required
  });

  it("ink bleed spreads beyond the stroke, then dries", async () => {
    const t = byId("ink-bleed");
    const dry = await result(t, 1, { ticks: 400, drying: 0.15 });
    const slow = await result(t, 1, { ticks: 400, drying: 0.01 });
    expect(dry.steps).toBeLessThan(slow.steps);
    expect(slow.steps).toBeLessThanOrEqual(400);
    expect(nonEmpty(slow.h.scratch)).toBeGreaterThan(0);
  });

  it("particles honour the tick count", async () => {
    const t = byId("particles");
    const r = await result(t, 1, { preset: "custom", lifetime: 200, drag: 0, gravity: 0, ticks: 17 });
    expect(r.steps).toBe(17);
    const short = await result(t, 1, { preset: "custom", lifetime: 5, ticks: 100 });
    expect(short.steps).toBeLessThan(10);
    expect(short.steps).toBeGreaterThan(0);
  });

  it("particle presets differ", async () => {
    const a = await result(byId("particles"), 1, { preset: "sparks" });
    const b = await result(byId("particles"), 1, { preset: "rain" });
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("tool behaviour", () => {
  it("pixel sort orders pixels within a run", async () => {
    const { sortPixels } = await import("./pixelsort");
    const src = makeImage(8, 1);
    const lum = [200, 50, 120, 10, 255, 90, 30, 160];
    lum.forEach((v, i) => src.data.set([v, v, v, 255], i * 4));
    const out = sortPixels(src, new Float32Array(8).fill(1), { low: 0, high: 1, angle: 0, brightFirst: false });
    expect(Array.from({ length: 8 }, (_, i) => out.data[i * 4])).toEqual([...lum].sort((a, b) => a - b));
    const bright = sortPixels(src, new Float32Array(8).fill(1), { low: 0.1, high: 0.9, angle: 0, brightFirst: false });
    expect(bright.data[4 * 4]).toBe(255); // the 255 pixel is above the range and stays put
    expect(bright.data[3 * 4]).toBe(10); // the 10 pixel is below it and stays put
  });

  it("smear moves colour along the stroke", async () => {
    const r = await result(byId("smear"), 1);
    expect(nonEmpty(r.h.scratch)).toBeGreaterThan(50);
  });

  it("echo draws count+1 copies", async () => {
    const h = createHarness({ params: { count: 3, offset: 10, angle: 90, fade: 0.2, shrink: 0 } });
    byId("echo-trail").onStrokeBegin(h.ctx, curvePoints()[0]!);
    expect(h.dabs.length).toBe(4);
  });

  it("growth uses the chosen leaf tip and season colours", async () => {
    const h = createHarness({ params: { tip: "lib:leaf-oak", season: "autumn", leafDensity: 1, depth: 3 } });
    await runStroke(byId("growth"), h, curvePoints());
    const leaves = h.dabs.filter((d) => d.style?.tip === "lib:leaf-oak");
    expect(leaves.length).toBeGreaterThan(0);
    expect(leaves.every((d) => d.style?.color !== undefined)).toBe(true);
  });

  it("growth falls back to dab() when the engine has no dabAs", async () => {
    const h = createHarness({ dabAs: false, params: { leafDensity: 1 } });
    await runStroke(byId("growth"), h, curvePoints());
    expect(h.dabs.length).toBeGreaterThan(0);
  });

  it("voronoi modes differ and mud fills the stroke", async () => {
    const a = await result(byId("voronoi-crackle"), 1, { mode: "cracks" });
    const b = await result(byId("voronoi-crackle"), 1, { mode: "glass" });
    const c = await result(byId("voronoi-crackle"), 1, { mode: "mud" });
    expect(new Set([a.hash, b.hash, c.hash]).size).toBe(3);
    expect(nonEmpty(c.h.scratch)).toBeGreaterThan(nonEmpty(a.h.scratch));
  });

  it("works without clearScratch (final render only)", async () => {
    for (const id of ["pixel-sort", "smear"]) {
      const r = await result(byId(id), 1, {}, 4, { clearScratch: false });
      expect(nonEmpty(r.h.scratch), id).toBeGreaterThan(0);
    }
  });
});

describe("post adapter CPU twins", () => {
  const layer = testLayer(40, 40);
  const paramsOf = (type: string, over: Record<string, number | string | boolean> = {}) => {
    const def = postDef(type as never)!;
    const p: Record<string, number | string | boolean> = {};
    for (const [k, s] of Object.entries(def.params)) p[k] = s.default;
    return { def, p: { ...p, ...over } };
  };

  it("are identity at amount 0 and change the picture otherwise", () => {
    for (const [type, on] of [
      ["posterize", { amount: 1, levels: 3 }],
      ["duotone", { amount: 1 }],
      ["pixelate", { amount: 0.6 }],
      ["twirl", { amount: 0.5 }],
      ["bulge", { amount: 0.8 }],
      ["wave", { amount: 0.8 }],
      ["kaleido", { amount: 1 }],
    ] as const) {
      const cpu = CPU_POSTS[type]!;
      const { p } = paramsOf(type, { amount: 0 });
      expect(hashImage(cpu(layer, p)), `${type} at 0`).toBe(hashImage(layer));
      const { p: q } = paramsOf(type, on);
      expect(hashImage(cpu(layer, q)), `${type} on`).not.toBe(hashImage(layer));
    }
  });

  it("posterize snaps to levels", () => {
    const { p } = paramsOf("posterize", { amount: 1, levels: 2 });
    const out = CPU_POSTS.posterize!(layer, p);
    for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c++) expect([0, 255]).toContain(out.data[i + c]);
  });

  it("runPost without GL uses the CPU twin and returns null when there is none", () => {
    const { def, p } = paramsOf("posterize", { amount: 1 });
    expect(runPost(def, CPU_POSTS.posterize, null, layer, p, 1, 0)).not.toBeNull();
    const v = paramsOf("vhs");
    expect(runPost(v.def, undefined, null, layer, v.p, 1, 0)).toBeNull();
  });

  it("GPU-only tools say so", () => {
    for (const t of ALGORITHMIC_TOOLS) {
      const pt = t as Partial<PostLabTool>;
      if (pt.postType) expect(typeof pt.cpu).toBe("boolean");
    }
    expect((byId("vhs") as PostLabTool).cpu).toBe(false);
    expect((byId("twirl") as PostLabTool).cpu).toBe(true);
  });

  // The GL path needs a real WebGL2 context, which the jsdom test environment lacks.
  const gl = (() => {
    try {
      return typeof OffscreenCanvas !== "undefined" ? (new OffscreenCanvas(8, 8).getContext("webgl2") as WebGL2RenderingContext | null) : null;
    } catch {
      return null;
    }
  })();
  it.skipIf(!gl)("GL and CPU paths agree within rounding", () => {
    for (const [type, on] of [["posterize", { amount: 1, levels: 4 }], ["twirl", { amount: 0.5 }], ["pixelate", { amount: 0.6 }]] as const) {
      const { def, p } = paramsOf(type, on);
      const a = runPost(def, undefined, gl, layer, p, 1, 0)!;
      const b = runPost(def, CPU_POSTS[type], null, layer, p, 1, 0)!;
      let worst = 0;
      for (let i = 0; i < a.data.length; i++) worst = Math.max(worst, Math.abs((a.data[i] as number) - (b.data[i] as number)));
      expect(worst, type).toBeLessThanOrEqual(3);
    }
  });
});

describe("source hygiene", () => {
  const files = import.meta.glob("./*.ts", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
  const banned = [["Math", "random"], ["Date", "now"], ["new", "Date"], ["performance", "now"]].map(([a, b]) => `${a}.${b}`.replace("new.Date", "new Date"));
  it("uses no unseeded randomness, wall clock or timers in any lab source", () => {
    for (const [name, src] of Object.entries(files)) {
      if (name.endsWith(".test.ts")) continue;
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const b of banned) expect(code.includes(b), `${name} uses ${b}`).toBe(false);
      expect(/\bsetTimeout\b|\bsetInterval\b|requestAnimationFrame/.test(code), `${name} uses timers`).toBe(false);
    }
  });
});

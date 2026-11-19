// @ts-nocheck -- uses node:child_process/fs/os (the project has no node typings); dev-only, gated by TOOLBOX_GL_CHECK
/**
 * The CPU-reference test of the `gradelook` pass (SPEC §E7): the real shader, run in a real WebGL2 context
 * (headless Edge on SwiftShader), against grade/math.ts on a 64 × 64 fixture with depth and subject ramps,
 * for Neon Noir's colour ops and a few other looks plus one table of every kind. Needs Edge, so it runs only
 * with TOOLBOX_GL_CHECK=1 (TOOLBOX_EDGE = the msedge.exe path if it isn't in the default place):
 *   TOOLBOX_GL_CHECK=1 npx vitest run src/grade/glcheck.test.ts
 * The shader sources are also compiled by the test below without GL (just checking they exist).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FULLSCREEN_VS } from "@/viz/gl/core";
import { GRADELOOK_SHADERS } from "@/viz/post/gradelook";
import { builtInLook } from "./builtins";
import { mulberry32 } from "./chaos";
import { compileRecipe } from "./compile";
import { defaultPixel, evalRows, toLin } from "./math";
import { packTable, parseTable } from "./pack";
import type { GradeRecipe } from "./types";

const W = 64;

function fixture() {
  const rnd = mulberry32(7);
  const src: number[] = [];
  const srgb: Array<[number, number, number]> = [];
  for (let i = 0; i < W * W; i++) {
    const c = [rnd(), rnd(), rnd()].map((v) => Math.round(v * 255) / 255) as [number, number, number];
    srgb.push(c);
    src.push(toLin(c[0]), toLin(c[1]), toLin(c[2]), 1);
  }
  const depth = Array.from({ length: W }, (_, tx) => Math.round((tx / (W - 1)) * 255));
  const subj = Array.from({ length: W }, (_, ty) => Math.round((ty / (W - 1)) * 255));
  const kinds = ["balance", "wheels", "curves", "hsl", "split", "gradmap", "chanmix", "solarize", "posterize", "invert", "huecycle", "transfer", "bleach", "vignette"] as const;
  const every: GradeRecipe = {
    v: 1, name: "t", tier: "mine", seed: 0, wildCurve: "linear",
    ops: kinds.map((kind, i) => ({
      id: `k0000${i.toString(36)}`, kind, on: true, amount: 0.8,
      region: i % 3 === 0 ? { kind: "near" as const, split: 0.5, feather: 0.3 } : { kind: "all" as const },
      params: kind === "transfer" ? { stats: [30, 5, -5, 14, 7, 7, 60, 8, -4, 18, 9, 9, 85, 3, 4, 10, 5, 5] } : kind === "chanmix" ? { matrix: [0.2, 0.9, 0, 0.5, 0, 0.2, 0, 0.5, 0.6, 0, 0, 0] } : {},
    })),
  };
  const looks: Array<[string, GradeRecipe, number]> = [
    ["neon-noir", builtInLook("neon-noir")!.recipe, 1],
    ["acid-bath", builtInLook("acid-bath")!.recipe, 1],
    ["midas", builtInLook("midas")!.recipe, 0.8],
    ["oil-slick", builtInLook("oil-slick")!.recipe, 1],
    ["teal-orange", builtInLook("teal-orange")!.recipe, 1],
    ["thermal", builtInLook("thermal")!.recipe, 1],
    ["depth-rainbow", builtInLook("depth-rainbow")!.recipe, 1],
    ["every-kind", every, 1],
  ];
  const cases = looks.map(([name, r, w]) => {
    const posts = compileRecipe(r, w, { depth: true, subject: true, people: true });
    // grain hashes in float32 on the GPU: its noise is random either way, so it isn't compared
    const ops = posts.flatMap((p) => (p.type === "gradelook" && typeof p.params.table === "string" && !p.params.restore ? parseTable(p.params.table).ops : [])).filter((o) => o.kind !== "grain");
    const t = packTable({ ops });
    const expected: number[] = [];
    for (let row = 0; row < W; row++) {
      for (let col = 0; col < W; col++) {
        const s = (subj[W - 1 - row] as number) / 255;
        const px = defaultPixel({ x: (col + 0.5) / W, y: (row + 0.5) / W, w: W, h: W, depth: (depth[col] as number) / 255, subject: s, people: s, t: 0 });
        expected.push(...evalRows(t.data, t.count, srgb[row * W + col] as [number, number, number], px));
      }
    }
    return { name, tab: Array.from(t.data), count: t.count, expected };
  });
  return { vs: FULLSCREEN_VS, ...GRADELOOK_SHADERS, W, src, depth, subj, cases };
}

describe("gradelook shader", () => {
  it("has the three programs and mirrors every op kind", () => {
    for (const s of Object.values(GRADELOOK_SHADERS)) expect(s).toContain("void main()");
    for (const fn of ["opBalance", "opWheels", "opCurves", "opHsl", "opSplit", "opGradmap", "opChanmix", "opSolarize", "opPosterize", "opInvert", "opHuecycle", "opTransfer", "opBleach", "opGrain", "opVignette"]) {
      expect(GRADELOOK_SHADERS.main, fn).toContain(`vec3 ${fn}(`);
    }
  });

  it.skipIf(!process.env.TOOLBOX_GL_CHECK)("equals the CPU reference within 2/255 in a real WebGL2 context", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grade-glcheck-"));
    try {
      fs.writeFileSync(path.join(dir, "shaders.json"), JSON.stringify(fixture()));
      const out = execFileSync(process.execPath, [path.resolve(__dirname, "../../scripts/grade-glcheck.mjs"), dir], { encoding: "utf8", timeout: 120000 });
      const res = JSON.parse(out) as Record<string, { maxDiff255: number; changed255: number }>;
      for (const [name, r] of Object.entries(res)) {
        expect(r.changed255, `${name} changes the picture`).toBeGreaterThan(5);
        expect(r.maxDiff255, `${name} vs the reference`).toBeLessThanOrEqual(2);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 150000);
});

/**
 * The .cube LUT bake (Phase 21 SPEC §E3.3). A 33³ identity lattice is laid out as a 1089 × 33 picture (x = r + 33·b,
 * y = g), run through the `gradelook` pass with the look's colour-only ops at the current Wildness (region "all",
 * no motion), and read back; `lutFromPixels` puts the values in .cube order (red fastest) for
 * GradeService.SaveCube(name, 33, floats). Ops a LUT can't hold (regions, texture, motion, spatial passes) are
 * left out and listed in `left`.
 *
 * Two bakers: `bakeLutGL` (the real pass, in the webview) and `bakeLutCPU` (the reference maths; the test
 * fallback and the numeric check of the lattice mapping).
 */
import { createContext, Fullscreen, Target } from "@/viz/gl/core";
import type { FrameInput } from "@/viz/layers/registry";
import { postDef } from "@/viz/post/registry";
import "@/viz/post";
import { opAmount } from "./compile";
import { OP_DEFS, opParams } from "./ops";
import { evalRows, toLin, toSrgb, type Vec3 } from "./math";
import { packTable, type GradeTable, type TableOp } from "./pack";
import type { GradeRecipe } from "./types";

export const LUT_SIZE = 33;

export interface LutPlan {
  table: GradeTable;
  /** Human lines for the export dialog: what a LUT can't hold. */
  left: string[];
}

/** The colour-only ops of a look at a wildness, as a gradelook table (region all), and what had to be left out. */
export function lutPlan(recipe: GradeRecipe, wild: number): LutPlan {
  const ops: TableOp[] = [];
  const left: string[] = [];
  for (const op of recipe.ops) {
    const amount = opAmount(op, wild, recipe.wildCurve);
    if (amount <= 0) continue; // off, or a chaos op that isn't active at this wildness
    const def = OP_DEFS[op.kind];
    const label = def.label;
    if (!def.colorOnly) {
      left.push(def.kind === "grain" || def.kind === "vignette" ? `${label}: texture and position effects` : `${label}: spatial effects`);
      continue;
    }
    if (op.region.kind !== "all") {
      left.push(`${label}: only applies to a region (${op.region.kind})`);
      continue;
    }
    if (op.anim) left.push(`${label}: motion`);
    ops.push({ kind: op.kind as TableOp["kind"], amount, region: { kind: "all" }, params: opParams(op) });
  }
  return { table: { ops }, left: [...new Set(left)] };
}

/** The lattice's picture size. */
export const latticeSize = (size = LUT_SIZE): { w: number; h: number } => ({ w: size * size, h: size });

/** The lattice colour (sRGB 0..1) at picture pixel (x, y). */
export function latticeColor(x: number, y: number, size = LUT_SIZE): Vec3 {
  const r = x % size;
  const b = Math.floor(x / size);
  return [r / (size - 1), y / (size - 1), b / (size - 1)];
}

/** Lattice picture pixels (RGBA floats, sRGB in the colour channels) → .cube order RGB floats (red fastest). */
export function lutFromPixels(rgba: ArrayLike<number>, size = LUT_SIZE): Float32Array {
  const { w } = latticeSize(size);
  const out = new Float32Array(size * size * size * 3);
  let o = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const i = (g * w + (r + size * b)) * 4;
        out[o++] = rgba[i] as number;
        out[o++] = rgba[i + 1] as number;
        out[o++] = rgba[i + 2] as number;
      }
    }
  }
  return out;
}

/** The reference bake: every lattice colour through the packed rows (no GL). */
export function bakeLutCPU(table: GradeTable, size = LUT_SIZE): Float32Array {
  const { data, count } = packTable(table);
  const { w, h } = latticeSize(size);
  const px = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = evalRows(data, count, latticeColor(x, y, size));
      px.set([c[0], c[1], c[2], 1], (y * w + x) * 4);
    }
  }
  return lutFromPixels(px, size);
}

export interface LutBake {
  size: number;
  /** size³ RGB triples, 0..1, red fastest: what GradeService.SaveCube(name, size, data) takes. */
  data: number[];
  /** What the .cube can't hold (regions, texture, motion, spatial passes), for the export dialog. */
  left: string[];
}

/** Bakes a look's colour-only ops at a wildness into a 33³ LUT: the real gradelook pass when WebGL2 is available, the reference maths otherwise. */
export function bakeLut(recipe: GradeRecipe, wild: number): LutBake {
  const { table, left } = lutPlan(recipe, wild);
  let floats: Float32Array;
  try {
    floats = bakeLutGL(table);
  } catch {
    floats = bakeLutCPU(table);
  }
  return { size: LUT_SIZE, data: Array.from(floats), left };
}

/** The real bake: the lattice through the gradelook pass on an offscreen WebGL2 context. Throws where WebGL2 isn't available. */
export function bakeLutGL(table: GradeTable, size = LUT_SIZE): Float32Array {
  const { w, h } = latticeSize(size);
  const canvas = new OffscreenCanvas(w, h);
  const gl = createContext(canvas, { alpha: true });
  const fs = new Fullscreen(gl);
  const input = new Target(gl, w, h);
  const output = new Target(gl, w, h);
  try {
    // The engine works in linear light, premultiplied: the lattice goes in as linear with alpha 1.
    const lin = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = latticeColor(x, y, size);
        lin.set([toLin(c[0]), toLin(c[1]), toLin(c[2]), 1], (y * w + x) * 4);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, input.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, lin);
    const def = postDef("gradelook");
    if (!def?.create) throw new Error("The gradelook pass isn't registered");
    const inst = def.create({ gl, fullscreen: fs, w, h, seed: 0 });
    const frame = { params: { table: JSON.stringify(table) }, tMs: 0 } as unknown as FrameInput;
    inst.render(input, output, frame);
    const buf = new Float32Array(w * h * 4);
    output.bind();
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
    inst.dispose();
    const px = new Float32Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const a = Math.max(buf[i * 4 + 3] as number, 1e-5);
      for (let k = 0; k < 3; k++) px[i * 4 + k] = Math.max(0, Math.min(1, toSrgb((buf[i * 4 + k] as number) / a)));
      px[i * 4 + 3] = 1;
    }
    return lutFromPixels(px, size);
  } finally {
    input.dispose();
    output.dispose();
    fs.dispose();
  }
}

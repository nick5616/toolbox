/**
 * How a look's colour ops reach the `gradelook` pass (Phase 21 §E3.1). The pass has a string param `table`
 * holding a JSON `GradeTable`; the pass packs it once into a 16 × 16 RGBA32F data texture (one row per op,
 * 16 texels of 4 floats) and reads it with texelFetch. Per-frame values (beat/bar pulses) come in as the
 * numeric params d0..d15 (0..1), so keyframes and signal mods work on them like on any other param.
 *
 * Row layout (texel: floats):
 *   0: kind code, amount, region code, region invert (0/1)
 *   1: region soft|feather, region split, anim wave (0 none, 1 sine, 2 saw, 3 external), anim speed (cycles / 10 s)
 *   2: anim depth (0..1: how much of the amount the wave takes away), 0, 0, 0
 *   3..: the kind's params (see PARAM_LAYOUT below; colours are sRGB 0..1)
 * grade/math.ts reads the same rows; the GLSL in viz/post/gradelook.ts mirrors it.
 */
import { hexToSrgb, parseStops } from "./color";
import { defaultParams } from "./ops";
import type { GradeOpKind, GradeParam, Region } from "./types";

export const TABLE_OPS = 16;
export const ROW_TEXELS = 16;
export const ROW_FLOATS = ROW_TEXELS * 4;

/** Codes of the kinds the gradelook pass runs. 0 is a gate row (region and pulse only; used by the restore pass). */
export const KIND_CODE = {
  gate: 0,
  balance: 1,
  wheels: 2,
  curves: 3,
  hsl: 4,
  split: 5,
  gradmap: 6,
  chanmix: 7,
  solarize: 8,
  posterize: 9,
  invert: 10,
  huecycle: 11,
  transfer: 12,
  bleach: 13,
  grain: 14,
  vignette: 15,
} as const;
export type TableKind = keyof typeof KIND_CODE;

export const REGION_CODE = { all: 0, highlights: 1, shadows: 2, midtones: 3, subject: 4, background: 5, people: 6, near: 7, far: 8 } as const;

export const ANIM_CODE = { none: 0, sine: 1, saw: 2, ext: 3 } as const;
export type TableWave = keyof typeof ANIM_CODE;

export interface TableAnim {
  wave: TableWave;
  /** Cycles per 10 s. */
  speed: number;
  /** 0..1: the share of the amount that follows the wave. */
  depth: number;
}

export interface TableOp {
  kind: TableKind;
  /** Already scaled by the Wildness (0..1). */
  amount: number;
  region: Region;
  anim?: TableAnim;
  params: Record<string, GradeParam>;
}

export interface GradeTable {
  ops: TableOp[];
}

const P0 = 3 * 4; // first param float

const asNum = (v: GradeParam | undefined, def: number): number => (typeof v === "number" && Number.isFinite(v) ? v : def);
const asArr = (v: GradeParam | undefined, len: number, def: number[]): number[] => (Array.isArray(v) && v.length === len ? v : def);

/** Packs one op into a row of ROW_FLOATS floats. */
export function packOp(op: TableOp): Float32Array {
  const row = new Float32Array(ROW_FLOATS);
  const kind = op.kind;
  row[0] = KIND_CODE[kind];
  row[1] = Math.max(0, Math.min(1, op.amount));
  const r = op.region;
  row[2] = REGION_CODE[r.kind];
  row[3] = "invert" in r && r.invert ? 1 : 0;
  if ("soft" in r) row[4] = r.soft;
  else if ("feather" in r) row[4] = r.feather;
  if ("split" in r) row[5] = r.split;
  const a = op.anim;
  if (a && a.wave !== "none") {
    row[6] = ANIM_CODE[a.wave];
    row[7] = a.speed;
    row[8] = Math.max(0, Math.min(1, a.depth));
  }
  if (kind === "gate") return row;
  const d = { ...defaultParams(kind as GradeOpKind), ...op.params };
  const put = (i: number, ...vals: number[]) => vals.forEach((v, j) => (row[P0 + i * 4 + j] = v));
  const col = (v: GradeParam | undefined) => hexToSrgb(typeof v === "string" ? v : "#000000");
  switch (kind) {
    case "balance":
      put(0, asNum(d.exposure, 0), asNum(d.temp, 0), asNum(d.tint, 0), asNum(d.contrast, 1));
      put(1, asNum(d.pivot, 0.5), asNum(d.saturation, 1), asNum(d.vibrance, 0));
      break;
    case "wheels": {
      const [l0, l1, l2] = asArr(d.lift, 3, [0, 0, 0]) as number[];
      const [g0, g1, g2] = asArr(d.gamma, 3, [0, 0, 0]) as number[];
      const [n0, n1, n2] = asArr(d.gain, 3, [0, 0, 0]) as number[];
      put(0, l0 ?? 0, l1 ?? 0, l2 ?? 0, asNum(d.offset, 0));
      put(1, g0 ?? 0, g1 ?? 0, g2 ?? 0);
      put(2, n0 ?? 0, n1 ?? 0, n2 ?? 0);
      break;
    }
    case "curves":
      (["master", "r", "g", "b"] as const).forEach((k, i) => {
        const c = asArr(d[k], 5, [0, 0.25, 0.5, 0.75, 1]) as number[];
        put(i * 2, c[0] ?? 0, c[1] ?? 0.25, c[2] ?? 0.5, c[3] ?? 0.75);
        put(i * 2 + 1, c[4] ?? 1);
      });
      break;
    case "hsl": {
      const hue = asArr(d.hue, 6, [0, 0, 0, 0, 0, 0]) as number[];
      const sat = asArr(d.sat, 6, [0, 0, 0, 0, 0, 0]) as number[];
      const lum = asArr(d.lum, 6, [0, 0, 0, 0, 0, 0]) as number[];
      for (let i = 0; i < 6; i++) put(i, hue[i] ?? 0, sat[i] ?? 0, lum[i] ?? 0);
      break;
    }
    case "split": {
      const s = col(d.shadow);
      const h = col(d.highlight);
      put(0, s[0], s[1], s[2], asNum(d.balance, 0));
      put(1, h[0], h[1], h[2]);
      break;
    }
    case "gradmap": {
      const stops = parseStops(d.stops) ?? parseStops("#000000@0,#ffffff@1") ?? [];
      const source = ["luma", "depth", "hue"].indexOf(String(d.source));
      const blend = ["replace", "color", "soft"].indexOf(String(d.blend));
      put(0, stops.length, Math.max(0, source), Math.max(0, blend), asNum(d.drift, 0));
      stops.forEach((s, i) => {
        const c = hexToSrgb(s.hex);
        put(1 + i, c[0], c[1], c[2], s.pos);
      });
      break;
    }
    case "chanmix": {
      const m = asArr(d.matrix, 12, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]) as number[];
      for (let i = 0; i < 3; i++) put(i, m[i * 3] ?? 0, m[i * 3 + 1] ?? 0, m[i * 3 + 2] ?? 0, m[9 + i] ?? 0);
      break;
    }
    case "solarize":
      put(0, asNum(d.threshold, 0.5), asNum(d.mix, 1));
      break;
    case "posterize":
      put(0, asNum(d.levels, 5));
      break;
    case "invert":
      put(0, d.r === false ? 0 : 1, d.g === false ? 0 : 1, d.b === false ? 0 : 1);
      break;
    case "huecycle":
      put(0, Math.max(0, ["luma", "depth", "radius"].indexOf(String(d.by))), asNum(d.cycles, 1), asNum(d.phase, 0));
      break;
    case "transfer": {
      const src = asArr(d.src, 18, []) as number[];
      const ref = asArr(d.stats, 18, []) as number[];
      for (let i = 0; i < 18; i++) {
        row[P0 + i] = src[i] ?? 0;
        row[P0 + 20 + i] = ref[i] ?? 0;
      }
      break;
    }
    case "bleach":
      put(0, asNum(d.mix, 1));
      break;
    case "grain":
      put(0, asNum(d.size, 1.2), asNum(d.colored, 0.3));
      break;
    case "vignette":
      put(0, asNum(d.size, 0.55), asNum(d.softness, 0.6), asNum(d.roundness, 0.5));
      break;
  }
  return row;
}

/** Packs a table into the data texture's floats (TABLE_OPS rows of ROW_FLOATS; unused rows are zero). */
export function packTable(t: GradeTable): { data: Float32Array; count: number } {
  const ops = t.ops.slice(0, TABLE_OPS);
  const data = new Float32Array(TABLE_OPS * ROW_FLOATS);
  ops.forEach((op, i) => data.set(packOp(op), i * ROW_FLOATS));
  return { data, count: ops.length };
}

const EMPTY: GradeTable = { ops: [] };

/** Reads the `table` param (JSON). Anything unreadable is an empty table (the pass is then an identity). */
export function parseTable(json: unknown): GradeTable {
  if (typeof json !== "string" || json === "" || json === "[]") return EMPTY;
  try {
    const raw = JSON.parse(json) as { ops?: unknown };
    if (!raw || !Array.isArray(raw.ops)) return EMPTY;
    return { ops: (raw.ops as TableOp[]).filter((o) => o && typeof o.kind === "string" && o.kind in KIND_CODE) };
  } catch {
    return EMPTY;
  }
}

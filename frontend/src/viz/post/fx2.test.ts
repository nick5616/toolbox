import { describe, expect, it } from "vitest";
import {
  colorPop,
  colorPopKeep,
  duotone,
  edgeStrength,
  halftoneCell,
  halftoneCoverage,
  hueDistance,
  leakIntensity,
  letterboxBar,
  TALL_BAR,
  luma,
  mono,
  monoValue,
  pixelBlock,
  pixelCentre,
  posterizeChannel,
  rgbHue,
  scanlineGain,
  sharpen,
  sobel,
  speedBucket,
  speedlineMask,
  vhsBucket,
  vhsWobble,
  type Vec3,
} from "./fx2math";
import { postDef } from "./index";
import type { PostType } from "../types";

describe("registration", () => {
  type P = { kind: string; min?: number; max?: number; default: unknown; options?: readonly string[] };
  const num = (min: number, max: number, d: number): P => ({ kind: "number", min, max, default: d });
  const col = (d: string): P => ({ kind: "color", default: d });
  const want: Record<string, Record<string, P>> = {
    pixelate: { amount: num(0, 1, 0) },
    halftone: {
      amount: num(0, 1, 0),
      dots: num(20, 240, 90),
      angle: num(-90, 90, 45),
      mode: { kind: "enum", default: "mono", options: ["mono", "color"] },
    },
    posterize: { amount: num(0, 1, 0), levels: num(2, 16, 5) },
    duotone: { amount: num(0, 1, 0), shadows: col("#1b0436"), highlights: col("#ff4fd8") },
    mono: { amount: num(0, 1, 0), contrast: num(0, 3, 1), hard: { kind: "bool", default: false } },
    colorpop: { amount: num(0, 1, 0), hue: num(0, 360, 0), range: num(5, 180, 30) },
    vhs: {
      amount: num(0, 1, 0),
      scanlines: num(0, 1, 0.5),
      bleed: num(0, 1, 0.5),
      wobble: num(0, 1, 0.3),
      noise: num(0, 1, 0.3),
    },
    letterbox: { amount: num(0, 1, 0), color: col("#000000") },
    lightleak: { amount: num(0, 1, 0), color: col("#ff8a3d"), speed: num(0, 2, 0.5) },
    speedlines: {
      amount: num(0, 1, 0),
      density: num(20, 240, 90),
      inner: num(0, 0.9, 0.35),
      color: col("#ffffff"),
      cx: num(0, 1, 0.5),
      cy: num(0, 1, 0.5),
    },
    sharpen: { amount: num(0, 2, 0) },
    outline: {
      amount: num(0, 1, 0),
      thickness: num(0.5, 4, 1),
      color: col("#000000"),
      mode: { kind: "enum", default: "ink", options: ["ink", "neon"] },
    },
  };
  for (const [id, params] of Object.entries(want)) {
    it(`${id} is a pass with the spec params`, () => {
      const def = postDef(id as PostType);
      expect(def, id).toBeDefined();
      expect(def?.kind).toBe("pass");
      expect(Object.keys(def?.params ?? {}).sort()).toEqual(Object.keys(params).sort());
      for (const [k, w] of Object.entries(params)) {
        const got = def?.params[k] as unknown as P;
        expect(got.kind, `${id}.${k}`).toBe(w.kind);
        expect(got.default, `${id}.${k}`).toEqual(w.default);
        if (w.min !== undefined) expect([got.min, got.max], `${id}.${k}`).toEqual([w.min, w.max]);
        if (w.options) expect(got.options).toEqual(w.options);
      }
    });
  }
});

describe("identity at amount 0", () => {
  const px: Vec3 = [0.31, 0.62, 0.08];
  it("pixelate has a 1 px block that samples the pixel itself", () => {
    expect(pixelBlock(0, 720)).toBe(1);
    for (const n of [0, 1, 17, 719]) expect(pixelCentre(n + 0.5, 1)).toBe(n + 0.5);
  });
  it("colour effects return the input", () => {
    expect(posterizeChannel(0.37, 5, 0)).toBe(0.37);
    expect(duotone(px, [0.1, 0, 0.2], [1, 0.3, 0.8], 0)).toEqual(px);
    expect(mono(px, 0, 2, true)).toEqual(px);
    expect(colorPop(px, 0, 200, 30)).toEqual(px);
    expect(sharpen(0.4, 0.1, 0)).toBe(0.4);
    expect(letterboxBar(1920, 1080, 0)).toBe(0);
    expect(scanlineGain(5, 3, 1, 0)).toBe(1);
    expect(vhsWobble(0.9, 0.2, 1, 0)).toBe(0);
  });
});

describe("pixelate", () => {
  it("block size is 1 + amount * 8 % of the short side", () => {
    expect(pixelBlock(1, 720)).toBeCloseTo(1 + 57.6);
    expect(pixelBlock(0.5, 1000)).toBeCloseTo(41);
  });
  it("every pixel in a block samples the block centre", () => {
    expect(pixelCentre(0.5, 10)).toBe(5);
    expect(pixelCentre(9.5, 10)).toBe(5);
    expect(pixelCentre(10.5, 10)).toBe(15);
  });
});

describe("posterize", () => {
  it("snaps to the given number of levels", () => {
    const seen = new Set<number>();
    for (let i = 0; i <= 100; i++) seen.add(posterizeChannel(i / 100, 5, 1));
    expect([...seen].sort()).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(posterizeChannel(0.3, 2, 1)).toBe(0);
    expect(posterizeChannel(0.7, 2, 1)).toBe(1);
  });
  it("mixes by amount", () => {
    expect(posterizeChannel(0.3, 2, 0.5)).toBeCloseTo(0.15);
  });
});

describe("duotone", () => {
  const sh: Vec3 = [0.01, 0, 0.05];
  const hi: Vec3 = [1, 0.08, 0.7];
  it("maps black to the shadows and white to the highlights", () => {
    expect(duotone([0, 0, 0], sh, hi, 1)).toEqual(sh);
    const w = duotone([1, 1, 1], sh, hi, 1);
    w.forEach((v, i) => expect(v).toBeCloseTo(hi[i] as number));
  });
  it("is a monotonic gradient in between", () => {
    const a = duotone([0.2, 0.2, 0.2], sh, hi, 1);
    const b = duotone([0.6, 0.6, 0.6], sh, hi, 1);
    expect(b[0]).toBeGreaterThan(a[0]);
  });
});

describe("mono", () => {
  it("hard thresholds at 50 % display luma", () => {
    const dark = monoValue(0.2, 1, true); // display 0.48
    const light = monoValue(0.25, 1, true); // display 0.53
    expect(dark).toBe(0);
    expect(light).toBe(1);
    for (const l of [0, 0.05, 0.1, 0.5, 1]) expect([0, 1]).toContain(monoValue(l, 1, true));
  });
  it("contrast 1 keeps luma, higher contrast pushes away from mid", () => {
    expect(monoValue(0.3, 1, false)).toBeCloseTo(0.3);
    expect(monoValue(0.1, 2, false)).toBeLessThan(0.1);
    expect(monoValue(0.5, 2, false)).toBeGreaterThan(0.5);
  });
  it("outputs grey", () => {
    const g = mono([0.9, 0.1, 0.2], 1, 1, false);
    expect(g[0]).toBeCloseTo(g[1]);
    expect(g[1]).toBeCloseTo(g[2]);
    expect(g[0]).toBeCloseTo(luma(0.9, 0.1, 0.2));
  });
});

describe("colour pop", () => {
  it("computes hues", () => {
    expect(rgbHue(1, 0, 0)).toBe(0);
    expect(rgbHue(0, 1, 0)).toBe(120);
    expect(rgbHue(0, 0, 1)).toBe(240);
    expect(hueDistance(350, 10)).toBe(20);
  });
  it("keeps the target hue and greys a far hue", () => {
    const red: Vec3 = [0.8, 0.1, 0.1];
    expect(colorPop(red, 1, 0, 30)).toEqual(red);
    const green: Vec3 = [0.1, 0.8, 0.1];
    const g = colorPop(green, 1, 0, 30);
    expect(g[0]).toBeCloseTo(g[1]);
    expect(g[1]).toBeCloseTo(g[2]);
  });
  it("wraps around 0/360 and fades past the range", () => {
    expect(colorPopKeep(350, 0, 30)).toBe(1);
    expect(colorPopKeep(0, 0, 30)).toBe(1);
    const mid = colorPopKeep(37, 0, 30);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(colorPopKeep(120, 0, 30)).toBe(0);
    expect(colorPopKeep(179, 0, 180)).toBe(1);
  });
});

describe("letterbox", () => {
  const picture = (w: number, h: number, a: number): number => h * (1 - 2 * letterboxBar(w, h, a));
  it("leaves a 2.39:1 picture at amount 1 on landscape frames", () => {
    for (const [w, h] of [[1920, 1080], [1440, 1080]] as const) {
      expect(w / picture(w, h, 1)).toBeCloseTo(2.39, 5);
    }
  });
  it("bar sizes for 9:16, 16:9 and 1:1 (tall and square frames get 12 % bars)", () => {
    expect(letterboxBar(1080, 1920, 1)).toBeCloseTo(TALL_BAR);
    expect(letterboxBar(1920, 1080, 1)).toBeCloseTo(0.1281, 3);
    expect(letterboxBar(1000, 1000, 1)).toBeCloseTo(TALL_BAR);
  });
  it("scales with amount and vanishes for frames already wider than 2.39:1", () => {
    expect(letterboxBar(1920, 1080, 0.5)).toBeCloseTo(letterboxBar(1920, 1080, 1) / 2);
    expect(letterboxBar(2560, 1000, 1)).toBe(0);
  });
});

describe("halftone", () => {
  it("dot coverage grows with luma", () => {
    const cell = 8;
    for (const d of [0, 1.5, 3, 4.5]) {
      let prev = -1;
      for (let l = 0; l <= 1.0001; l += 0.05) {
        const c = halftoneCoverage(l, d, cell);
        expect(c).toBeGreaterThanOrEqual(prev);
        prev = c;
      }
    }
    expect(halftoneCoverage(0, 0, cell)).toBe(0);
    expect(halftoneCoverage(0, 3, cell)).toBe(0);
    expect(halftoneCoverage(1, cell * 0.6, cell)).toBe(1);
  });
  it("total coverage over a cell is monotonic in luma", () => {
    const cell = 10;
    const area = (l: number): number => {
      let s = 0;
      for (let y = 0; y < 40; y++) {
        for (let x = 0; x < 40; x++) s += halftoneCoverage(l, halftoneCell(x + 0.5, y + 0.5, cell, 45).d, cell);
      }
      return s;
    };
    const a = [0.1, 0.3, 0.5, 0.8].map(area);
    for (let i = 1; i < a.length; i++) expect(a[i] as number).toBeGreaterThan(a[i - 1] as number);
  });
  it("cells rotate with the angle and centres are consistent", () => {
    const c0 = halftoneCell(13, 7, 10, 0);
    expect(c0.cx).toBeCloseTo(15);
    expect(c0.cy).toBeCloseTo(5);
    const r = halftoneCell(13, 7, 10, 45);
    expect(r.d).toBeLessThanOrEqual(10 * Math.SQRT1_2 + 1e-9);
  });
});

describe("speed lines", () => {
  it("is deterministic per 2-frame bucket and changes between buckets", () => {
    expect(speedBucket(0)).toBe(speedBucket(65));
    expect(speedBucket(66)).toBe(1);
    const row = (b: number): number[] =>
      Array.from({ length: 90 }, (_, i) => speedlineMask(((i + 0.5) / 90) * 2 * Math.PI, 0.8, 90, 0.35, b, 4));
    expect(row(speedBucket(10))).toEqual(row(speedBucket(60)));
    expect(row(3)).not.toEqual(row(4));
    expect(row(3)).toEqual(row(3));
  });
  it("keeps the inner radius clear", () => {
    for (let i = 0; i < 90; i++) expect(speedlineMask((i / 90) * 6.28, 0.1, 90, 0.35, 5, 1)).toBe(0);
    const lit = Array.from({ length: 90 }, (_, i) => speedlineMask(((i + 0.5) / 90) * 6.28, 0.95, 90, 0.35, 5, 1));
    expect(lit.some((v) => v > 0.5)).toBe(true);
  });
});

describe("vhs, light leak, sharpen, outline", () => {
  it("buckets time deterministically", () => {
    expect(vhsBucket(32)).toBe(0);
    expect(vhsBucket(33)).toBe(1);
  });
  it("scanlines darken alternate rows by up to 30 %", () => {
    expect(scanlineGain(0, 2, 1, 1)).toBeCloseTo(0.7);
    expect(scanlineGain(1, 2, 1, 1)).toBeCloseTo(1);
  });
  it("light leak drifts with time, is deterministic and bounded", () => {
    const a = leakIntensity(0.4, 0.4, 1000, 0.5, 3);
    expect(leakIntensity(0.4, 0.4, 1000, 0.5, 3)).toBe(a);
    expect(leakIntensity(0.4, 0.4, 9000, 0.5, 3)).not.toBe(a);
    expect(leakIntensity(0.4, 0.4, 1000, 0, 3)).toBe(leakIntensity(0.4, 0.4, 9000, 0, 3));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(1);
  });
  it("sharpen raises local contrast", () => {
    expect(sharpen(0.6, 0.4, 1)).toBeCloseTo(0.8);
    expect(sharpen(0.6, 0.6, 2)).toBeCloseTo(0.6);
    expect(sharpen(0.1, 0.9, 2)).toBe(0);
  });
  it("sobel is zero on flat areas and strong on a step", () => {
    expect(sobel([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])).toBe(0);
    const step = sobel([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(edgeStrength(step)).toBe(1);
    expect(edgeStrength(0)).toBe(0);
  });
});

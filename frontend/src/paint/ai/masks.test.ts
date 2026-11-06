import { describe, expect, it } from "vitest";
import { anchorFor, buildFill, extendBands, ringMask } from "./masks";
import { alphaBounds, createImage } from "./pixels";

function disc(w: number, h: number, cx: number, cy: number, r: number): ImageData {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) img.data[(y * w + x) * 4 + 3] = 255;
  return img;
}

function count(img: ImageData): number {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) n++;
  return n;
}

describe("ringMask", () => {
  it("keeps only the outer ring of the stroke", () => {
    const m = disc(41, 41, 20, 20, 15);
    const ring = ringMask(m, 4);
    expect(count(ring)).toBeGreaterThan(0);
    expect(count(ring)).toBeLessThan(count(m));
    // the centre is not in the ring, the rim is
    expect(ring.data[(20 * 41 + 20) * 4 + 3]).toBe(0);
    expect(ring.data[(20 * 41 + 6) * 4 + 3]).toBe(255);
    // a ring never leaves the stroke
    const b = alphaBounds(ring)!;
    const sb = alphaBounds(m)!;
    expect(b).toEqual(sb);
  });
  it("a wider ring covers more", () => {
    const m = disc(41, 41, 20, 20, 15);
    expect(count(ringMask(m, 8))).toBeGreaterThan(count(ringMask(m, 2)));
  });
  it("a thin stroke becomes all ring", () => {
    const m = disc(21, 21, 10, 10, 3);
    expect(count(ringMask(m, 10))).toBe(count(m));
  });
});

describe("buildFill", () => {
  const stroke = disc(20, 20, 10, 10, 6);
  it("passes the stroke through for fill eraser and Dissolve", () => {
    expect(buildFill("fill-eraser", stroke, {}).mask).toBe(stroke);
    const d = buildFill("dissolve", stroke, { passes: 99, ghost: 0.5, drift: 2, quality: "fast" });
    expect(d.fields).toMatchObject({ passes: 12, ghost: 0.5, drift: 1, model: "fast", driftDir: "" });
  });
  it("Melt carries the drift direction", () => {
    for (const dir of ["down", "up", "left", "right"]) {
      expect(buildFill("melt", stroke, { direction: dir }).fields.driftDir).toBe(dir);
    }
    expect(buildFill("melt", stroke, { direction: "sideways" }).fields.driftDir).toBe("down");
  });
  it("Echo carries the offset", () => {
    expect(buildFill("echo-fill", stroke, { offsetX: -30, offsetY: 12 }).fields.offset).toEqual([-30, 12]);
  });
  it("Edge erode sends a ring", () => {
    const e = buildFill("edge-erode", stroke, { width: 2 });
    expect(count(e.mask)).toBeLessThan(count(stroke));
  });
  it("rejects unknown tools", () => {
    expect(() => buildFill("nope", stroke, {})).toThrow();
  });
});

describe("extendBands", () => {
  function cover(oldW: number, oldH: number, m: { top: number; right: number; bottom: number; left: number }) {
    const newW = oldW + m.left + m.right;
    const newH = oldH + m.top + m.bottom;
    const hits = new Uint8Array(newW * newH);
    for (const b of extendBands(oldW, oldH, m)) {
      expect(b.bounds.w).toBeLessThanOrEqual(newW);
      expect(b.mask.width).toBe(b.bounds.w);
      for (let y = b.bounds.y; y < b.bounds.y + b.bounds.h; y++) for (let x = b.bounds.x; x < b.bounds.x + b.bounds.w; x++) hits[y * newW + x]!++;
    }
    return { hits, newW, newH };
  }
  it("covers every new pixel exactly once and none of the old", () => {
    const m = { top: 100, right: 1300, bottom: 600, left: 513 };
    const { hits, newW, newH } = cover(300, 200, m);
    for (let y = 0; y < newH; y++) {
      for (let x = 0; x < newW; x++) {
        const inOld = x >= m.left && x < m.left + 300 && y >= m.top && y < m.top + 200;
        expect(hits[y * newW + x]).toBe(inOld ? 0 : 1);
      }
    }
  });
  it("uses bands of at most 512 px, outward from the edge", () => {
    const bands = extendBands(100, 100, { top: 0, right: 1100, bottom: 0, left: 0 });
    expect(bands.map((b) => b.bounds.w)).toEqual([512, 512, 76]);
    expect(bands.map((b) => b.bounds.x)).toEqual([100, 612, 1124]);
  });
  it("is empty when nothing grows", () => {
    expect(extendBands(10, 10, { top: 0, right: 0, bottom: 0, left: 0 })).toEqual([]);
  });
  it("anchors the old pixels by the margins", () => {
    expect(anchorFor({ top: 0, right: 100, bottom: 0, left: 0 })).toEqual({ x: 0, y: 0 });
    expect(anchorFor({ top: 10, right: 0, bottom: 30, left: 50 })).toEqual({ x: 1, y: 0.25 });
  });
});

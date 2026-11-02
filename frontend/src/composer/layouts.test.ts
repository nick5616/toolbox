import { describe, expect, it } from "vitest";
import type { ComposerLayer, Composition } from "@/lib/api";
import { boxBounds, layerBox, type Sizer } from "./hittest";
import { applyLayout, gridShape, LAYOUTS, type LayoutKind } from "./layouts";
import { addLayer, newComposition, newImageLayer, newTextLayer } from "./model";
import { makeRng } from "./rng";

const KINDS = LAYOUTS.map((l) => l.id);

// Pictures of mixed shapes: (aspect w/h) by layer id; layer widths come from size.
const ASPECT: Record<string, number> = { p0: 1.5, p1: 0.75, p2: 1, p3: 2, p4: 0.6, p5: 1.33, p6: 1, p7: 0.8, p8: 1.2 };
const sizer =
  (doc: Composition): Sizer =>
  (l) => {
    const w = l.size * doc.width;
    const crop = l.image?.crop ?? { w: 1, h: 1 };
    const a = ((ASPECT[l.id] ?? 1) * crop.w) / crop.h;
    return { w, h: w / a };
  };

function photos(n: number, aspect = "4:5"): Composition {
  let d = newComposition(aspect);
  for (let i = 0; i < n; i++) {
    const l = newImageLayer(`/p${i}.jpg`, 1500, 1000, d);
    l.id = `p${i}`;
    d = addLayer(d, l);
  }
  return d;
}

/** Axis-aligned bounds of a layer's picture (rotation included, outline excluded). */
function bounds(doc: Composition, l: ComposerLayer) {
  return boxBounds(layerBox(doc, l, sizer(doc)));
}

describe("applyLayout", () => {
  it("is deterministic for a seed and changes with another", () => {
    const d = photos(6);
    for (const kind of KINDS) {
      const a = applyLayout(d, kind, 42, undefined, sizer(d));
      const b = applyLayout(d, kind, 42, undefined, sizer(d));
      expect(b).toEqual(a);
      const c = applyLayout(d, kind, 43, undefined, sizer(d));
      expect(c.layers).not.toEqual(a.layers);
    }
  });

  it("keeps every layer inside the canvas", () => {
    for (const aspect of ["4:5", "1:1", "9:16", "16:9", "1.91:1"]) {
      for (const n of [1, 2, 3, 5, 8, 12, 20]) {
        const d = photos(n, aspect);
        for (const kind of KINDS) {
          for (const seed of [1, 7, 99]) {
            const out = applyLayout(d, kind, seed, undefined, sizer(d));
            for (const l of out.layers ?? []) {
              const b = bounds(out, l);
              const where = `${kind} ${aspect} n=${n} seed=${seed} ${l.id}`;
              expect(b.left, where).toBeGreaterThanOrEqual(-0.5);
              expect(b.top, where).toBeGreaterThanOrEqual(-0.5);
              expect(b.right, where).toBeLessThanOrEqual(d.width + 0.5);
              expect(b.bottom, where).toBeLessThanOrEqual(d.height + 0.5);
            }
          }
        }
      }
    }
  });

  it("scatter: alternates sides, leaves the middle free, tilts ±12°, adds outline and shadow", () => {
    const d = photos(6);
    const out = applyLayout(d, "scatter", 5, undefined, sizer(d));
    const left = (out.layers ?? []).filter((l) => l.x < 0.5);
    expect(left).toHaveLength(3);
    expect(out.layers?.length).toBe(6);
    for (const l of out.layers ?? []) {
      expect(Math.abs(l.rotation)).toBeLessThanOrEqual(12);
      expect(l.outline.on).toBe(true);
      expect(l.shadow.on).toBe(true);
      const b = bounds(out, l);
      // Nothing covers the middle fifth of the canvas width.
      expect(b.left > 0.4 * d.width || b.right < 0.6 * d.width, l.id).toBe(true);
    }
  });

  it("grid: equal tiles with rounded corners, filled by cropping, no tilt", () => {
    const d = photos(4);
    const out = applyLayout(d, "grid", 3, undefined, sizer(d));
    const sizes = new Set((out.layers ?? []).map((l) => l.size.toFixed(4)));
    expect(sizes.size).toBe(1);
    const xs = new Set((out.layers ?? []).map((l) => l.x.toFixed(3)));
    const ys = new Set((out.layers ?? []).map((l) => l.y.toFixed(3)));
    expect([xs.size, ys.size]).toEqual([2, 2]);
    for (const l of out.layers ?? []) {
      expect(l.rotation).toBe(0);
      expect(l.image?.radius).toBeGreaterThan(0);
      expect(l.outline.on).toBe(false);
      // Cropped to the cell's shape: no two tiles overlap.
    }
    const rects = (out.layers ?? []).map((l) => bounds(out, l));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlap = a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
        expect(overlap, `${i}/${j}`).toBe(false);
      }
    }
    // The crop stays inside the picture.
    for (const l of out.layers ?? []) {
      const c = l.image!.crop;
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(c.y + c.h).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("grid shapes run from 2×2 up to 4×5", () => {
    expect(gridShape(1, true)).toEqual([1, 1]);
    expect(gridShape(4, true)).toEqual([2, 2]);
    expect(gridShape(5, true)).toEqual([2, 3]);
    expect(gridShape(9, false)).toEqual([3, 3]);
    expect(gridShape(16, true)).toEqual([4, 4]);
    expect(gridShape(20, true)).toEqual([4, 5]);
    for (let n = 1; n <= 40; n++) {
      const [c, r] = gridShape(n, n % 2 === 0);
      expect(c * r).toBeGreaterThanOrEqual(n);
    }
  });

  it("stack: overlapping, slightly rotated cards with shadows", () => {
    const d = photos(4);
    const out = applyLayout(d, "stack", 11, undefined, sizer(d));
    const rects = (out.layers ?? []).map((l) => bounds(out, l));
    let overlaps = 0;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (rects[i]!.left < rects[j]!.right && rects[j]!.left < rects[i]!.right && rects[i]!.top < rects[j]!.bottom && rects[j]!.top < rects[i]!.bottom) overlaps++;
    expect(overlaps).toBeGreaterThan(0);
    for (const l of out.layers ?? []) {
      expect(Math.abs(l.rotation)).toBeLessThanOrEqual(8);
      expect(l.shadow.on).toBe(true);
    }
  });

  it("polaroids: white 3 % frame, square crop, free caption strip at the bottom", () => {
    const d = photos(4);
    const out = applyLayout(d, "polaroids", 2, undefined, sizer(d));
    for (const l of out.layers ?? []) {
      expect(l.outline).toMatchObject({ on: true, width: 0.03, color: "#ffffff" });
      const s = sizer(out)(l);
      expect(s.w / s.h).toBeCloseTo(1, 2);
      const b = bounds(out, l);
      expect(b.bottom + 0.03 * d.width).toBeLessThanOrEqual(0.9 * d.height);
    }
  });

  it("only touches the chosen layers; other layers and the background stay", () => {
    let d = photos(4);
    d = addLayer(d, newTextLayer(d));
    d = { ...d, background: { ...d.background, color: "#123456" } };
    const before = JSON.stringify(d);
    const out = applyLayout(d, "scatter", 1, ["p1", "p2"], sizer(d));
    expect(JSON.stringify(d)).toBe(before); // input untouched
    expect(out.background).toBe(d.background);
    const L = (doc: Composition, id: string) => (doc.layers ?? []).find((l) => l.id === id) as ComposerLayer;
    expect(L(out, "p0")).toBe(L(d, "p0"));
    expect(L(out, "p3")).toBe(L(d, "p3"));
    expect(L(out, "p1")).not.toEqual(L(d, "p1"));
    expect((out.layers ?? []).map((l) => l.id)).toEqual((d.layers ?? []).map((l) => l.id));
    expect(out.layers?.at(-1)).toBe(d.layers?.at(-1)); // the text layer
  });

  it("skips hidden and locked layers; nothing to do returns the same document", () => {
    let d = photos(3);
    d = { ...d, layers: (d.layers ?? []).map((l, i) => (i === 0 ? { ...l, hidden: true } : i === 1 ? { ...l, locked: true } : l)) };
    const out = applyLayout(d, "grid", 1, undefined, sizer(d));
    expect(out.layers?.[0]).toBe(d.layers?.[0]);
    expect(out.layers?.[1]).toBe(d.layers?.[1]);
    expect(out.layers?.[2]).not.toBe(d.layers?.[2]);
    expect(applyLayout(newComposition(), "scatter", 1)).toEqual(newComposition());
    const empty = newComposition();
    expect(applyLayout(empty, "stack", 1)).toBe(empty);
    expect(applyLayout(d, "stack", 1, ["nope"])).toBe(d);
  });

  it("works without a sizer (square pictures)", () => {
    const d = photos(3);
    for (const kind of KINDS as LayoutKind[]) expect(applyLayout(d, kind, 9).layers?.every((l) => l.size > 0)).toBe(true);
  });
});

describe("rng", () => {
  it("is deterministic and uniform enough", () => {
    const a = makeRng(7);
    const b = makeRng(7);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(Array.from({ length: 5 }, () => b.next()));
    const r = makeRng(1);
    const xs = Array.from({ length: 2000 }, () => r.next());
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(xs.reduce((s, v) => s + v, 0) / xs.length).toBeCloseTo(0.5, 1);
    expect(makeRng(2).shuffle([1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(makeRng(2).range(3, 4)).toBeGreaterThanOrEqual(3);
  });
});

import { describe, expect, it } from "vitest";
import { RED, BLUE, blankDoc, line, noTiles, px, pt, strokeLine, testBrush, testEngine } from "./testing";
import type { ToolState } from "./types";

const brush = (over = {}, color = RED): ToolState => ({ kind: "brush", brush: testBrush(over), color, secondary: color, seed: 1 });

describe("painting", () => {
  it("a stroke lands on the layer and merges at stroke opacity", async () => {
    const e = await testEngine(64, 64);
    const res = strokeLine(e, brush({ opacity: 0.5, size: 10 }), line(10, 32, 54, 32));
    expect(res.history).not.toBeNull();
    const [r, g, b, a] = await px(e, 30, 32);
    expect(r).toBe(255);
    expect(g).toBe(0);
    expect(b).toBe(0);
    // Overlapping dabs inside one stroke never exceed the stroke opacity.
    expect(a).toBeGreaterThanOrEqual(126);
    expect(a).toBeLessThanOrEqual(129);
    expect((await px(e, 30, 5))[3]).toBe(0);
  });

  it("the eraser uses the brush tip", async () => {
    const e = await testEngine(64, 64);
    strokeLine(e, brush({ size: 30 }), line(10, 32, 54, 32));
    strokeLine(e, { kind: "eraser", brush: testBrush({ size: 10 }), seed: 1 }, line(10, 32, 54, 32));
    expect((await px(e, 30, 32))[3]).toBe(0);
    expect((await px(e, 30, 22))[3]).toBeGreaterThan(200); // outside the eraser, inside the paint
  });

  it("alpha lock keeps the layer's alpha", async () => {
    const e = await testEngine(64, 64);
    strokeLine(e, brush({ size: 20 }), line(10, 32, 30, 32));
    e.setLayer("l1", { alphaLock: true });
    strokeLine(e, brush({ size: 40 }, BLUE), line(0, 32, 60, 32));
    expect((await px(e, 50, 32))[3]).toBe(0); // no new alpha
    const [r, , b] = await px(e, 20, 32);
    expect(b).toBe(255);
    expect(r).toBe(0);
  });

  it("a locked layer ignores strokes", async () => {
    const e = await testEngine(64, 64);
    e.setLayer("l1", { locked: true });
    const res = strokeLine(e, brush(), line(10, 10, 50, 10));
    expect(res.history).toBeNull();
  });

  it("the same strokes replay to identical pixels", async () => {
    const mk = async () => {
      const e = await testEngine(96, 96);
      const wild = {
        scatter: 0.4,
        count: 3,
        size: 14,
        color: { hueJitter: 0.4, satJitter: 0.2, briJitter: 0.2, perStroke: false, secondaryMix: 0 },
        tip: { shape: "round" as const, hardness: 0.4, roundness: 0.6, angle: 0, angleMode: "stroke" as const, rotationJitter: 0.5, invert: false },
      };
      strokeLine(e, brush(wild), line(10, 10, 80, 70, 3));
      return Array.from(e.readPixels({ x: 0, y: 0, w: 96, h: 96 }, "layer").data);
    };
    expect(await mk()).toEqual(await mk());
  });

  it("selection clips painting", async () => {
    const e = await testEngine(64, 64);
    e.selection.rect({ x: 0, y: 0, w: 32, h: 64 });
    strokeLine(e, brush({ size: 20 }), line(5, 32, 60, 32));
    expect((await px(e, 20, 32))[3]).toBe(255);
    expect((await px(e, 50, 32))[3]).toBe(0);
  });

  it("mask strokes return a mask and leave the layer alone", async () => {
    const e = await testEngine(64, 64);
    const res = strokeLine(e, { kind: "mask", brush: testBrush({ size: 10 }), seed: 1 }, line(10, 32, 50, 32));
    expect(res.history).toBeNull();
    expect(res.mask).toBeDefined();
    expect(res.mask!.width).toBe(res.bounds.w);
    const mid = ((Math.floor(res.mask!.height / 2) * res.mask!.width) + 20) * 4 + 3;
    expect(res.mask!.data[mid]).toBeGreaterThan(200);
    expect((await px(e, 30, 32))[3]).toBe(0);
  });

  it("pixel brushes do not antialias", async () => {
    const e = await testEngine(32, 32);
    strokeLine(e, brush({ size: 3, antialias: false }), [pt(10.3, 10.7), pt(10.3, 10.7, 8)]);
    const vals = [] as number[];
    const d = e.readPixels({ x: 0, y: 0, w: 32, h: 32 }, "layer").data;
    for (let i = 3; i < d.length; i += 4) vals.push(d[i]!);
    expect(new Set(vals.filter((v) => v > 0))).toEqual(new Set([255]));
  });

  it("smudge drags colour", async () => {
    const e = await testEngine(64, 64);
    strokeLine(e, brush({ size: 24 }), line(10, 32, 30, 32));
    const res = strokeLine(e, { kind: "smudge", brush: testBrush({ size: 16, opacity: 0.9 }), seed: 1 }, line(20, 32, 50, 32));
    expect(res.history).not.toBeNull();
    expect((await px(e, 40, 32))[3]).toBeGreaterThan(30); // paint was carried right
  });

  it("wet mix picks up the canvas colour", async () => {
    const e = await testEngine(64, 64);
    strokeLine(e, brush({ size: 30 }, BLUE), line(10, 32, 54, 32));
    strokeLine(e, brush({ size: 10, wet: { mix: 1, dilution: 0, charge: 1, pull: 0, grade: 0, edges: 0, bleed: 0 } }), line(20, 32, 40, 32));
    const [r, , b] = await px(e, 30, 32);
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(60);
  });

  it("bleed spreads a stroke past its edge", async () => {
    const plain = await testEngine(64, 64);
    const wet = await testEngine(64, 64);
    const w = { mix: 0, dilution: 0, charge: 1, pull: 0, grade: 0, edges: 0, bleed: 1 };
    strokeLine(plain, brush({ size: 10 }), line(10, 32, 50, 32));
    strokeLine(wet, brush({ size: 10, wet: w }), line(10, 32, 50, 32));
    expect((await px(plain, 30, 40))[3]).toBe(0);
    expect((await px(wet, 30, 40))[3]).toBeGreaterThan(0);
  });
});

describe("history", () => {
  it("undoes and redoes tiles", async () => {
    const e = await testEngine(64, 64);
    strokeLine(e, brush({ size: 20 }), line(10, 32, 50, 32));
    const painted = Array.from(e.readPixels({ x: 0, y: 0, w: 64, h: 64 }, "layer").data);
    expect(e.undo()).toBe(true);
    expect((await px(e, 30, 32))[3]).toBe(0);
    expect(e.redo()).toBe(true);
    expect(Array.from(e.readPixels({ x: 0, y: 0, w: 64, h: 64 }, "layer").data)).toEqual(painted);
    expect(e.history()).toHaveLength(1);
  });

  it("drops the oldest steps over the memory budget", async () => {
    const e = await testEngine(64, 64, { budget: { total: 1500, gpu: 0 } });
    for (let i = 0; i < 6; i++) strokeLine(e, brush({ size: 6 }), line(5 + i * 8, 10, 10 + i * 8, 50));
    const h = e.history();
    expect(h.some((s) => !s.available)).toBe(true);
    expect(h[h.length - 1]!.available).toBe(true);
    expect(e.undo()).toBe(true);
    // The newest steps still undo; the dropped ones stop the chain.
    let n = 0;
    while (e.undo()) n++;
    expect(n).toBeLessThan(5);
  });

  it("snapshotAt gives an earlier state for the History brush", async () => {
    const e = await testEngine(64, 64);
    const first = strokeLine(e, brush({ size: 20 }, RED), line(10, 32, 50, 32));
    strokeLine(e, brush({ size: 20 }, BLUE), line(10, 32, 50, 32));
    const snap = await e.snapshotAt(first.history!, { x: 30, y: 32, w: 1, h: 1 });
    expect(Array.from(snap.data.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    // The History brush paints that back.
    strokeLine(e, { kind: "history", brush: testBrush({ size: 10 }), source: first.history!, seed: 1 }, line(25, 32, 35, 32));
    expect(await px(e, 30, 32)).toEqual([255, 0, 0, 255]);
    expect((await px(e, 45, 32))[2]).toBe(255);
  });
});

describe("layers and compositing", () => {
  it("blends layers with their modes and opacity", async () => {
    const e = await testEngine(16, 16, {}, "#ffffff", 1);
    strokeLine(e, brush({ size: 40 }, { r: 0.5, g: 0.5, b: 0.5, a: 1 }), [pt(8, 8), pt(8, 8, 8)]);
    const top = e.addLayer({ blend: "multiply" });
    strokeLine(e, brush({ size: 40 }, { r: 0.5, g: 0.5, b: 0.5, a: 1 }), [pt(8, 8), pt(8, 8, 8)]);
    expect(top).toBe(e.doc.active);
    const m = await px(e, 8, 8, "merged");
    expect(m[0]).toBeGreaterThan(55);
    expect(m[0]).toBeLessThan(72); // 0.5 × 0.5 ≈ 64
    e.setLayer(top, { opacity: 0 });
    expect((await px(e, 8, 8, "merged"))[0]).toBeGreaterThan(120);
  });

  it("clipping layers only show where the base has paint", async () => {
    const e = await testEngine(64, 64);
    strokeLine(e, brush({ size: 20 }), line(10, 32, 30, 32));
    e.addLayer({ clip: true });
    strokeLine(e, brush({ size: 60 }, BLUE), line(0, 32, 64, 32));
    expect((await px(e, 20, 32, "merged"))[2]).toBeGreaterThan(200);
    expect((await px(e, 55, 32, "merged"))[3]).toBe(0);
  });

  it("merge down, duplicate, remove, flatten and undo them", async () => {
    const e = await testEngine(64, 64);
    strokeLine(e, brush({ size: 20 }), line(10, 20, 50, 20));
    const l2 = e.addLayer();
    strokeLine(e, brush({ size: 20 }, BLUE), line(10, 44, 50, 44));
    const dup = e.duplicateLayer(l2);
    expect(e.doc.layers).toHaveLength(3);
    e.removeLayer(dup);
    expect(e.doc.layers).toHaveLength(2);
    e.mergeDown(l2);
    expect(e.doc.layers).toHaveLength(1);
    expect((await px(e, 30, 44))[2]).toBe(255);
    expect(e.undo()).toBe(true);
    expect(e.doc.layers).toHaveLength(2);
    e.redo();
    e.addLayer();
    e.flatten();
    expect(e.doc.layers).toHaveLength(1);
    expect((await px(e, 30, 20))[0]).toBe(255);
    e.undo();
    expect(e.doc.layers!.length).toBeGreaterThan(1);
  });

  it("merged readRegion includes the background and is transparent off-canvas", async () => {
    const e = await testEngine(16, 16, {}, "#00ff00");
    const d = (await e.readRegion({ x: -2, y: 0, w: 4, h: 1 }, "merged")).data;
    expect(d[3]).toBe(0);
    expect(Array.from(d.subarray(8, 12))).toEqual([0, 255, 0, 255]);
  });
});

describe("fill and selection", () => {
  it("bucket fills a closed region and respects tolerance", async () => {
    const e = await testEngine(64, 64);
    // A closed square outline on one layer, fill on another (reference layer).
    const lines = e.doc.active;
    for (const [a, b, c, d] of [[10, 10, 50, 10], [50, 10, 50, 50], [50, 50, 10, 50], [10, 50, 10, 10]] as const) strokeLine(e, brush({ size: 3 }), line(a, b, c, d, 2));
    e.setLayer(lines, { reference: true });
    e.addLayer();
    const id = e.fill({ x: 30, y: 30 }, { tolerance: 0.1, sampleAll: false, color: BLUE });
    expect(id).not.toBeNull();
    expect((await px(e, 30, 30))[2]).toBe(255);
    expect((await px(e, 5, 5))[3]).toBe(0); // outside the outline: untouched
  });

  it("lasso selects a polygon and fills it", async () => {
    const e = await testEngine(64, 64);
    e.selection.lasso([{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 10, y: 50 }]);
    expect(e.selection.bounds()).toEqual({ x: 10, y: 10, w: 40, h: 40 });
    const m = e.selection.mask()!;
    expect(m.data[(30 * 64 + 30) * 4 + 3]).toBe(255);
    expect(m.data[(5 * 64 + 5) * 4 + 3]).toBe(0);
    e.fill({ x: 30, y: 30 }, { tolerance: 1, sampleAll: false, color: RED });
    expect((await px(e, 30, 30))[0]).toBe(255);
    expect((await px(e, 5, 5))[3]).toBe(0);
  });

  it("wand honours tolerance and contiguity", async () => {
    const e = await testEngine(64, 64, {}, "#ffffff");
    strokeLine(e, brush({ size: 12 }, { r: 0.2, g: 0.2, b: 0.2, a: 1 }), [pt(20, 32), pt(20, 32, 8)]);
    e.selection.wand({ x: 20, y: 32 }, { tolerance: 0, contiguous: true, sampleAll: true });
    const b = e.selection.bounds()!;
    expect(b.w).toBeLessThan(16);
    e.selection.wand({ x: 2, y: 2 }, { tolerance: 0.1, contiguous: true, sampleAll: true });
    expect(e.selection.bounds()!.w).toBe(64);
    e.selection.wand({ x: 2, y: 2 }, { tolerance: 0.1, contiguous: true, sampleAll: true }, "subtract");
    expect(e.selection.active).toBe(false);
  });

  it("invert, feather and grow", async () => {
    const e = await testEngine(64, 64);
    e.selection.rect({ x: 20, y: 20, w: 20, h: 20 });
    e.selection.grow(4);
    expect(e.selection.bounds()).toEqual({ x: 16, y: 16, w: 28, h: 28 });
    e.selection.grow(-4);
    expect(e.selection.bounds()!.w).toBe(20);
    e.selection.feather(6);
    const m = e.selection.mask()!;
    const edge = m.data[(30 * 64 + 20) * 4 + 3]!;
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
    e.selection.invert();
    expect(e.selection.mask()!.data[(2 * 64 + 2) * 4 + 3]).toBe(255);
    e.selection.clear();
    expect(e.selection.active).toBe(false);
  });
});

describe("regions and canvas", () => {
  it("writeRegion applies a mask with feather as one undo step", async () => {
    const e = await testEngine(32, 32);
    const img = { data: new Uint8ClampedArray(8 * 8 * 4).fill(255), width: 8, height: 8 } as unknown as ImageData;
    const mask = { data: new Uint8ClampedArray(8 * 8 * 4), width: 8, height: 8 } as unknown as ImageData;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) mask.data[(y * 8 + x) * 4 + 3] = 255;
    const id = e.writeRegion("l1", { x: 4, y: 4, w: 8, h: 8 }, img, mask, 0);
    expect(id).toBeGreaterThan(0);
    expect((await px(e, 5, 6))[3]).toBe(255);
    expect((await px(e, 10, 6))[3]).toBe(0);
    expect(e.history()).toHaveLength(1);
    e.undo();
    expect((await px(e, 5, 6))[3]).toBe(0);
  });

  it("resizeCanvas keeps pixels at the anchor and new areas transparent", async () => {
    const e = await testEngine(32, 32);
    strokeLine(e, brush({ size: 8 }), [pt(4, 4), pt(4, 4, 8)]);
    e.resizeCanvas(64, 48, { x: 0, y: 0 });
    expect(e.doc.width).toBe(64);
    expect(e.doc.height).toBe(48);
    expect((await px(e, 4, 4))[3]).toBe(255);
    expect((await px(e, 50, 40))[3]).toBe(0);
    e.resizeCanvas(64, 48, { x: 1, y: 1 });
    e.undo();
    e.undo();
    expect(e.doc.width).toBe(32);
    expect((await px(e, 4, 4))[3]).toBe(255);
  });

  it("resample scales the layer", async () => {
    const e = await testEngine(32, 32);
    strokeLine(e, brush({ size: 12 }), [pt(8, 8), pt(8, 8, 8)]);
    e.resample(64, 64);
    expect(e.doc.width).toBe(64);
    expect((await px(e, 16, 16))[3]).toBeGreaterThan(200);
    expect((await px(e, 50, 50))[3]).toBe(0);
  });
});

describe("transform", () => {
  it("commits a flip exactly and undoes", async () => {
    const e = await testEngine(64, 64);
    strokeLine(e, brush({ size: 8 }), [pt(10, 20), pt(10, 20, 8)]);
    e.transform.begin("free");
    expect(e.transform.active).toBe(true);
    e.transform.flip("h");
    e.transform.commit("bilinear");
    expect(e.transform.active).toBe(false);
    const xs: number[] = [];
    const d = e.readPixels({ x: 0, y: 0, w: 64, h: 64 }, "layer").data;
    for (let x = 0; x < 64; x++) if (d[(20 * 64 + x) * 4 + 3]) xs.push(x);
    // The dab spanned x 6..14 around centre 10; flipped about itself it stays put.
    expect(Math.min(...xs)).toBe(6);
    expect(e.undo()).toBe(true);
  });

  it("moves, scales and cancels", async () => {
    const e = await testEngine(64, 64);
    strokeLine(e, brush({ size: 10 }), [pt(16, 16), pt(16, 16, 8)]);
    e.transform.begin("free");
    e.transform.set({ matrix: [1, 0, 0, 1, 20, 0] });
    expect((await px(e, 36, 16))[3]).toBeGreaterThan(200);
    expect((await px(e, 16, 16))[3]).toBe(0);
    e.transform.cancel();
    expect((await px(e, 16, 16))[3]).toBeGreaterThan(200);
    expect((await px(e, 36, 16))[3]).toBe(0);

    e.transform.begin("free");
    e.transform.set({ matrix: [2, 0, 0, 2, -16, -16] }); // 2× about (16,16)
    e.transform.commit("bicubic");
    expect((await px(e, 16, 16))[3]).toBeGreaterThan(200);
    expect((await px(e, 22, 16))[3]).toBeGreaterThan(200); // reaches ~r=10
    e.undo();
    expect((await px(e, 22, 16))[3]).toBe(0);
  });

  it("transforms only the selection and rotates 90°", async () => {
    const e = await testEngine(64, 64);
    strokeLine(e, brush({ size: 8 }), [pt(10, 10), pt(10, 10, 8)]);
    strokeLine(e, brush({ size: 8 }, BLUE), [pt(50, 50), pt(50, 50, 8)]);
    e.selection.rect({ x: 0, y: 0, w: 24, h: 24 });
    e.transform.begin("free");
    e.transform.set({ matrix: [1, 0, 0, 1, 0, 30] });
    e.transform.commit("bilinear");
    expect((await px(e, 10, 40))[0]).toBe(255);
    expect((await px(e, 10, 10))[3]).toBe(0);
    expect((await px(e, 50, 50))[2]).toBe(255);
    e.selection.clear();
    e.transform.begin("uniform");
    e.transform.rotate90(1);
    e.transform.commit("bilinear");
    expect(e.history().length).toBeGreaterThanOrEqual(4);
  });

  it("distort and warp produce pixels", async () => {
    const e = await testEngine(64, 64);
    strokeLine(e, brush({ size: 20 }), [pt(32, 32), pt(32, 32, 8)]);
    e.transform.begin("distort");
    e.transform.set({ corners: [{ x: 22, y: 22 }, { x: 42, y: 26 }, { x: 42, y: 38 }, { x: 22, y: 42 }] });
    e.transform.commit("bilinear");
    expect((await px(e, 32, 32))[3]).toBeGreaterThan(200);
    e.transform.begin("warp");
    const mesh = Array.from({ length: 16 }, (_, i) => ({ x: 22 + (i % 4) * 7, y: 22 + Math.floor(i / 4) * 7 }));
    e.transform.set({ mesh });
    e.transform.commit("bicubic");
    expect((await px(e, 32, 32))[3]).toBeGreaterThan(150);
  });
});

describe("saving and loading", () => {
  it("tracks dirty tiles, encodes and reloads them", async () => {
    const e = await testEngine(64, 64);
    expect(e.dirtyTiles().size).toBe(0);
    strokeLine(e, brush({ size: 10 }), line(10, 32, 50, 32));
    const dirty = e.dirtyTiles();
    expect([...(dirty.get("l1") ?? [])]).toEqual(["0_0"]);
    const blob = await e.encodeTile("l1", "0_0");
    expect(blob).not.toBeNull();
    e.markSaved("l1", ["0_0"]);
    expect(e.dirtyTiles().size).toBe(0);
    expect(await e.encodeTile("l1", "9_9")).toBeNull();

    // Reload from the encoded tile; edge tiles may be smaller than 512.
    const bytes = new Uint8Array(await blob!.arrayBuffer());
    const { rawCodec } = await import("./testing");
    const img = await rawCodec.decode(bytes);
    expect(img.width).toBe(64);
    const doc = blankDoc(64, 64);
    doc.layers![0]!.tiles = ["0_0"];
    const e2 = await testEngine(8, 8);
    await e2.load(doc, { load: async () => new Map([["0_0", img as unknown as ImageBitmap]]) });
    expect(Array.from(e2.readPixels({ x: 0, y: 0, w: 64, h: 64 }, "layer").data)).toEqual(Array.from(e.readPixels({ x: 0, y: 0, w: 64, h: 64 }, "layer").data));
  });

  it("an erased-out tile encodes to null", async () => {
    const e = await testEngine(64, 64);
    strokeLine(e, brush({ size: 10 }), [pt(32, 32), pt(32, 32, 8)]);
    strokeLine(e, { kind: "eraser", brush: testBrush({ size: 60 }), seed: 1 }, [pt(32, 32), pt(32, 32, 8)]);
    expect(await e.encodeTile("l1", "0_0")).toBeNull();
  });

  it("flattenToBitmap scales", async () => {
    const e = await testEngine(32, 32, {}, "#ffffff");
    const b = (await e.flattenToBitmap(2)) as unknown as { width: number; height: number };
    expect(b.width).toBe(64);
    expect(b.height).toBe(64);
  });

  it("failed tile loads are reported and the layer stays usable", async () => {
    const e = await testEngine(8, 8);
    const doc = blankDoc(64, 64);
    doc.layers![0]!.tiles = ["0_0"];
    await e.load(doc, { load: async () => { throw new Error("boom"); } });
    expect(e.failedTiles().get("l1")).toEqual(["0_0"]);
    void noTiles;
  });
});

describe("view", () => {
  it("maps screen and canvas both ways with rotation and flip", async () => {
    const e = await testEngine(200, 100);
    e.setViewport(800, 600);
    e.view.fit();
    const p = { x: 37, y: 61 };
    for (const v of [{ rotation: 0, flipped: false }, { rotation: 33, flipped: false }, { rotation: 90, flipped: true }]) {
      e.view.set({ ...v, zoom: 2.5, panX: 17, panY: -9 });
      const s = e.view.canvasToScreen(p);
      const back = e.view.screenToCanvas(s);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
    e.view.set({ rotation: 0, flipped: false, zoom: 1, panX: 0, panY: 0 });
    expect(e.view.canvasToScreen({ x: 100, y: 50 })).toEqual({ x: 400, y: 300 });
  });
});

import { describe, expect, it } from "vitest";
import { RED, line, strokeLine, testBrush, testEngine } from "../engine/testing";
import type { Point } from "../engine/types";
import { LineAssist, defaultGuides, gridLines, parseGuides, snapToGrid, stringifyGuides } from "./guides";
import { detectShape, moveHandle, shapeHandles, shapeInputPoints, shapePath } from "./quickshape";

const jitter = (p: Point[], amp: number): Point[] => p.map((q, i) => ({ x: q.x + Math.sin(i * 12.9898) * amp, y: q.y + Math.cos(i * 78.233) * amp }));
const ring = (cx: number, cy: number, rx: number, ry: number, n = 60): Point[] => Array.from({ length: n + 1 }, (_, i) => ({ x: cx + rx * Math.cos((i / n) * Math.PI * 2), y: cy + ry * Math.sin((i / n) * Math.PI * 2) }));

describe("QuickShape", () => {
  it("snaps a wobbly stroke to a line", () => {
    const pts = jitter(line(0, 0, 200, 40, 5).map((p) => ({ x: p.x, y: p.y })), 1.2);
    const s = detectShape(pts);
    expect(s?.kind).toBe("line");
  });
  it("snaps a ring to an ellipse and a box to a rectangle", () => {
    const e = detectShape(jitter(ring(100, 100, 60, 40), 1.5));
    expect(e?.kind).toBe("ellipse");
    if (e?.kind === "ellipse") {
      expect(Math.max(e.rx, e.ry)).toBeCloseTo(60, -1);
      expect(Math.min(e.rx, e.ry)).toBeCloseTo(40, -1);
    }
    const box: Point[] = [];
    const corners = [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 80 }, { x: 0, y: 80 }, { x: 0, y: 0 }];
    for (let i = 0; i < 4; i++) for (let k = 0; k < 20; k++) box.push({ x: corners[i]!.x + ((corners[i + 1]!.x - corners[i]!.x) * k) / 20, y: corners[i]!.y + ((corners[i + 1]!.y - corners[i]!.y) * k) / 20 });
    box.push({ x: 0, y: 0 });
    const r = detectShape(jitter(box, 1));
    expect(r?.kind).toBe("rect");
  });
  it("snaps a triangle to a polygon and refuses scribbles", () => {
    const tri = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 90 }, { x: 0, y: 0 }];
    const pts: Point[] = [];
    for (let i = 0; i < 3; i++) for (let k = 0; k < 20; k++) pts.push({ x: tri[i]!.x + ((tri[i + 1]!.x - tri[i]!.x) * k) / 20, y: tri[i]!.y + ((tri[i + 1]!.y - tri[i]!.y) * k) / 20 });
    pts.push({ x: 0, y: 0 });
    const s = detectShape(pts);
    expect(s?.kind).toBe("polygon");
    if (s?.kind === "polygon") expect(s.points).toHaveLength(3);
    expect(detectShape([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
    const scribble = Array.from({ length: 40 }, (_, i) => ({ x: (i * 37) % 90, y: (i * 53) % 70 }));
    expect(detectShape(scribble)).toBeNull();
  });
  it("shapes have handles and a path, and re-stroke through the engine", async () => {
    const s = { kind: "line" as const, a: { x: 10, y: 10 }, b: { x: 90, y: 10 } };
    expect(shapeHandles(s)).toHaveLength(2);
    expect(moveHandle(s, 1, { x: 90, y: 50 })).toMatchObject({ kind: "line", b: { x: 90, y: 50 } });
    expect(shapePath(s, 2)).toHaveLength(41);
    const e = await testEngine(100, 100);
    const tool = { kind: "brush" as const, brush: testBrush({ size: 6 }), color: RED, secondary: RED, seed: 1 };
    const first = strokeLine(e, tool, line(10, 60, 90, 70));
    expect(first.history).not.toBeNull();
    const res = e.restroke(tool, shapeInputPoints(s));
    expect(res.history).not.toBeNull();
    // The wobbly stroke is gone; the straight one replaced it.
    expect(e.readPixels({ x: 50, y: 65, w: 1, h: 1 }, "layer").data[3]).toBe(0);
    expect(e.readPixels({ x: 50, y: 10, w: 1, h: 1 }, "layer").data[3]).toBeGreaterThan(200);
    expect(e.history()).toHaveLength(1);
  });
});

describe("guides", () => {
  it("round-trips through the doc's JSON string", () => {
    expect(parseGuides("")).toEqual(defaultGuides());
    const g = defaultGuides();
    g.symmetry = { mode: "radial", count: 6, cx: 10, cy: 20 };
    g.perspective = { points: 2, vps: [{ x: 0, y: 0 }, { x: 100, y: 0 }], assist: true };
    expect(parseGuides(stringifyGuides(g))).toEqual(g);
    expect(stringifyGuides(defaultGuides())).toBe("");
    expect(parseGuides("{nope")).toEqual(defaultGuides());
  });
  it("snaps to the grid and lists its lines", () => {
    expect(snapToGrid({ on: true, size: 10, snap: true }, { x: 13, y: 26 })).toEqual({ x: 10, y: 30 });
    expect(gridLines({ on: true, size: 50, snap: false }, { x: 0, y: 0, w: 120, h: 60 })).toEqual({ xs: [0, 50, 100], ys: [0, 50] });
  });
  it("assist locks a stroke to the nearest vanishing line", () => {
    const g = defaultGuides();
    g.perspective = { points: 1, vps: [{ x: 1000, y: 0 }], assist: true };
    const a = new LineAssist(g);
    a.begin({ x: 0, y: 0 });
    const out = { x: 0, y: 0 };
    a.map(5, 3, out); // under the lock distance: unchanged
    expect(out).toEqual({ x: 5, y: 3 });
    a.map(100, 12, out);
    expect(out.y).toBeCloseTo(0, 6);
    expect(out.x).toBeCloseTo(100, 6);
    const iso = defaultGuides();
    iso.iso = { on: true, assist: true };
    const b = new LineAssist(iso);
    b.begin({ x: 0, y: 0 });
    b.map(2, 60, out);
    b.map(3, 90, out);
    expect(out.x).toBeCloseTo(0, 6); // locked to the vertical axis
  });
  it("an engine with symmetry paints the mirror image", async () => {
    const e = await testEngine(100, 100);
    const g = defaultGuides();
    g.symmetry = { mode: "vertical", count: 2, cx: 50, cy: 0 };
    e.setGuides(g);
    expect(e.doc.guides).not.toBe("");
    strokeLine(e, { kind: "brush", brush: testBrush({ size: 8 }), color: RED, secondary: RED, seed: 1 }, line(10, 20, 30, 20));
    expect(e.readPixels({ x: 20, y: 20, w: 1, h: 1 }, "layer").data[3]).toBe(255);
    expect(e.readPixels({ x: 80, y: 20, w: 1, h: 1 }, "layer").data[3]).toBe(255);
    expect(e.readPixels({ x: 50, y: 20, w: 1, h: 1 }, "layer").data[3]).toBe(0);
  });
  it("a guide-assisted stroke is straight", async () => {
    const e = await testEngine(100, 100);
    const g = defaultGuides();
    g.perspective = { points: 1, vps: [{ x: 5000, y: 50 }], assist: true };
    e.setGuides(g);
    strokeLine(e, { kind: "brush", brush: testBrush({ size: 4 }), color: RED, secondary: RED, seed: 1 }, [
      { x: 10, y: 50, pressure: 1, tiltX: 0, tiltY: 0, twist: 0, t: 0, pointer: "pen" },
      { x: 40, y: 56, pressure: 1, tiltX: 0, tiltY: 0, twist: 0, t: 8, pointer: "pen" },
      { x: 80, y: 44, pressure: 1, tiltX: 0, tiltY: 0, twist: 0, t: 16, pointer: "pen" },
    ]);
    expect(e.readPixels({ x: 60, y: 50, w: 1, h: 1 }, "layer").data[3]).toBeGreaterThan(200);
    expect(e.readPixels({ x: 60, y: 44, w: 1, h: 1 }, "layer").data[3]).toBe(0);
  });
});

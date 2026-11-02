import { describe, expect, it } from "vitest";
import type { ComposerLayer, Composition } from "@/lib/api";
import {
  boxBounds, boxCorners, handlePositions, hitHandle, hitLayer, layerBox, pointInBox, rotationFromPointer, scaleFromHandle, snapMove, toLocal,
  type Box, type Sizer,
} from "./hittest";
import { addLayer, newComposition, newImageLayer } from "./model";

// Every layer is 200×100 canvas px.
const sizer: Sizer = () => ({ w: 200, h: 100 });

function layer(id: string, x: number, y: number, extra: Partial<ComposerLayer> = {}): ComposerLayer {
  const l = newImageLayer(`/${id}.png`, 2, 1, newComposition("1:1"));
  return { ...l, id, x, y, ...extra };
}

function docOf(...layers: ComposerLayer[]): Composition {
  return layers.reduce((d, l) => addLayer(d, l), newComposition("1:1")); // 1080×1080
}

const box = (cx: number, cy: number, w: number, h: number, rot = 0): Box => ({ cx, cy, w, h, rot });
const close = (a: { x: number; y: number }, x: number, y: number) => {
  expect(a.x).toBeCloseTo(x, 5);
  expect(a.y).toBeCloseTo(y, 5);
};

describe("boxes", () => {
  it("corners and bounds follow the rotation (clockwise)", () => {
    const b = box(100, 100, 40, 20, 90);
    const [tl, tr, br, bl] = boxCorners(b);
    // 90° clockwise: the top-left corner (-20,-10) goes to (10,-20) relative to the centre.
    close(tl, 110, 80);
    close(tr, 110, 120);
    close(br, 90, 120);
    close(bl, 90, 80);
    const bb = boxBounds(b);
    expect([bb.left, bb.right, bb.top, bb.bottom].map(Math.round)).toEqual([90, 110, 80, 120]);
    const diag = boxBounds(box(0, 0, 100, 100, 45));
    expect(diag.right).toBeCloseTo(70.71, 1);
  });

  it("layerBox converts fractions to canvas px", () => {
    const d = docOf(layer("a", 0.25, 0.75, { rotation: 30 }));
    expect(layerBox(d, d.layers![0]!, sizer)).toEqual({ cx: 270, cy: 810, w: 200, h: 100, rot: 30 });
  });

  it("pointInBox respects rotation", () => {
    const b = box(100, 100, 200, 20, 90); // a tall thin bar after rotating
    expect(pointInBox(b, { x: 100, y: 190 })).toBe(true); // along the bar
    expect(pointInBox(b, { x: 190, y: 100 })).toBe(false); // where the unrotated bar would be
    expect(pointInBox(b, { x: 115, y: 100 })).toBe(false);
    expect(pointInBox(b, { x: 115, y: 100 }, 6)).toBe(true);
    close(toLocal(b, { x: 100, y: 190 }), 90, 0);
  });
});

describe("hitLayer", () => {
  it("returns the topmost visible, unlocked layer", () => {
    const d = docOf(layer("under", 0.5, 0.5), layer("over", 0.5, 0.5), layer("far", 0.9, 0.9));
    expect(hitLayer(d, { x: 540, y: 540 }, sizer)?.id).toBe("over");
    expect(hitLayer(d, { x: 10, y: 10 }, sizer)).toBeNull();
    const hidden = docOf(layer("under", 0.5, 0.5), layer("over", 0.5, 0.5, { hidden: true }));
    expect(hitLayer(hidden, { x: 540, y: 540 }, sizer)?.id).toBe("under");
    const locked = docOf(layer("under", 0.5, 0.5), layer("over", 0.5, 0.5, { locked: true }));
    expect(hitLayer(locked, { x: 540, y: 540 }, sizer)?.id).toBe("under");
    expect(hitLayer(locked, { x: 540, y: 540 }, sizer, { includeLocked: true })?.id).toBe("over");
  });

  it("uses the rotated outline, not the bounding box", () => {
    const d = docOf(layer("a", 0.5, 0.5, { rotation: 45 }));
    // A point inside the unrotated 200×100 rectangle's corner area but outside the rotated one.
    expect(hitLayer(d, { x: 540 + 95, y: 540 - 45 }, sizer)).toBeNull();
    // A point along the rotated long axis, beyond the unrotated rectangle.
    const t = 80 / Math.SQRT2;
    expect(hitLayer(d, { x: 540 + t + 2, y: 540 + t - 2 }, sizer)?.id).toBe("a");
  });
});

describe("handles", () => {
  it("positions the corners and the rotate handle above the top edge", () => {
    const b = box(100, 100, 40, 20);
    const h = handlePositions(b, { radius: 8, rotateOffset: 30 });
    close(h.nw, 80, 90);
    close(h.se, 120, 110);
    close(h.rotate, 100, 60);
    const r = handlePositions(box(100, 100, 40, 20, 90), { radius: 8, rotateOffset: 30 });
    close(r.rotate, 140, 100); // rotated 90° clockwise: "above" points right
  });

  it("hits handles within the radius", () => {
    const b = box(100, 100, 40, 20, 90);
    const g = { radius: 8, rotateOffset: 30 };
    expect(hitHandle(b, { x: 140, y: 103 }, g)).toBe("rotate");
    const [tl] = boxCorners(b);
    expect(hitHandle(b, { x: tl.x + 3, y: tl.y - 3 }, g)).toBe("nw");
    expect(hitHandle(b, { x: 100, y: 100 }, g)).toBeNull();
    expect(hitHandle(b, { x: tl.x + 20, y: tl.y }, g)).toBeNull();
  });

  it("scales uniformly about the opposite corner, or the centre with Alt", () => {
    const b = box(100, 100, 40, 20);
    // Drag the bottom-right corner (120,110) out to twice the diagonal from the top-left (80,90).
    const r = scaleFromHandle(b, "se", { x: 160, y: 130 }, false);
    expect(r.factor).toBeCloseTo(2);
    close({ x: r.cx, y: r.cy }, 120, 110); // top-left stays at (80,90)
    const c = scaleFromHandle(b, "se", { x: 140, y: 120 }, true);
    expect(c.factor).toBeCloseTo(2);
    close({ x: c.cx, y: c.cy }, 100, 100);
    // Dragging past the anchor never flips or collapses.
    expect(scaleFromHandle(b, "se", { x: 0, y: 0 }, false).factor).toBeGreaterThan(0);
    // Off-diagonal movement projects onto the diagonal.
    expect(scaleFromHandle(b, "ne", { x: 120, y: 90 }, false).factor).toBeCloseTo(1);
  });

  it("works on a rotated box", () => {
    const b = box(100, 100, 40, 20, 90);
    const [, tr] = boxCorners(b);
    const bl = boxCorners(b)[3];
    const out = scaleFromHandle(b, "ne", { x: tr.x + (tr.x - bl.x), y: tr.y + (tr.y - bl.y) }, false);
    expect(out.factor).toBeCloseTo(2); // pointer twice as far from the anchor
  });

  it("rotation from the pointer, with optional snapping", () => {
    expect(rotationFromPointer({ cx: 0, cy: 0 }, { x: 0, y: -50 })).toBeCloseTo(0);
    expect(rotationFromPointer({ cx: 0, cy: 0 }, { x: 50, y: 0 })).toBeCloseTo(90);
    expect(Math.abs(rotationFromPointer({ cx: 0, cy: 0 }, { x: 0, y: 50 }))).toBeCloseTo(180);
    expect(rotationFromPointer({ cx: 0, cy: 0 }, { x: -50, y: 0 })).toBeCloseTo(-90);
    expect(rotationFromPointer({ cx: 0, cy: 0 }, { x: 52, y: -50 }, 15)).toBe(45);
  });
});

describe("snapMove", () => {
  const doc = { width: 1000, height: 800 };

  it("snaps centre and edges to the canvas within the threshold", () => {
    const r = snapMove(doc, box(497, 403, 100, 50), [], 6);
    expect(r.dx).toBe(3);
    expect(r.dy).toBe(-3);
    expect(r.guides).toEqual(
      expect.arrayContaining([
        { axis: "x", pos: 500, from: 0, to: 800 },
        { axis: "y", pos: 400, from: 0, to: 1000 },
      ]),
    );
    const edge = snapMove(doc, box(54, 100, 100, 50), [], 6); // left edge at 4 → 0
    expect(edge.dx).toBe(-4);
    const far = snapMove(doc, box(300, 200, 100, 50), [], 6);
    expect([far.dx, far.dy, far.guides.length]).toEqual([0, 0, 0]);
  });

  it("snaps to other layers' edges and centres, picking the nearest", () => {
    const others = [box(200, 600, 100, 100)]; // edges x 150/250, centre 200; y 550/650, centre 600
    const r = snapMove(doc, box(262, 300, 100, 60), others, 12);
    // Left edge at 212 → centre 200 is 12 away; right edge at 312 no; centre 262 → 250 is 12 away.
    expect(Math.abs(r.dx)).toBe(12);
    const near = snapMove(doc, box(204, 100, 100, 60), others, 6);
    expect(near.dx).toBe(-4); // centre to centre
    expect(near.guides.find((g) => g.axis === "x" && g.pos === 200)).toMatchObject({ from: 70, to: 650 });
    // Both axes at once.
    const both = snapMove(doc, box(204, 597, 100, 60), others, 6);
    expect([both.dx, both.dy]).toEqual([-4, 3]);
  });

  it("uses the rotated bounds", () => {
    const rot = box(500, 400, 200, 40, 90); // vertical bar 40 wide, 200 tall
    const r = snapMove(doc, { ...rot, cx: 503 }, [], 6);
    expect(r.dx).toBe(-3);
    // A 45° square is wider than its sides; its left bound snaps, not its unrotated edge.
    const diamond = snapMove(doc, box(72, 400, 100, 100, 45), [], 6); // left bound at 72-70.7=1.3 → 0
    expect(diamond.dx).toBeCloseTo(-1.29, 1);
  });
});

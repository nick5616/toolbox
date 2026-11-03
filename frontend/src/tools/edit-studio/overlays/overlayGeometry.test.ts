import { describe, expect, it } from "vitest";
import {
  angleDeg,
  boxFor,
  boxToCanvas,
  boxToMaskLocal,
  canvasToBox,
  cornerPoint,
  displaySize,
  drawnSize,
  maskCentreFromDrag,
  maskCorners,
  maskLocalToBox,
  maskSizeFromCorner,
  nearestEdge,
  rotateHandle,
  rotatePt,
  rotationFromDrag,
  safeZones,
  scaleFromDrag,
  snapAngle,
  snapCentre,
  type Pt,
} from "./overlayGeometry";

const frame = { w: 540, h: 960 };
const near = (a: Pt, b: Pt, d = 1e-6) => {
  expect(a.x).toBeCloseTo(b.x, 5 + d * 0);
  expect(a.y).toBeCloseTo(b.y, 5);
};

describe("drawn size", () => {
  it("covers for fill and contains for the fit modes", () => {
    const wide = { w: 1920, h: 1080 };
    const fill = drawnSize("fill", wide, frame);
    expect(fill.h).toBeCloseTo(960);
    expect(fill.w).toBeCloseTo((1920 * 960) / 1080);
    const fit = drawnSize("fit", wide, frame);
    expect(fit.w).toBeCloseTo(540);
    expect(fit.h).toBeCloseTo(303.75);
    expect(drawnSize("fit-blur", wide, frame)).toEqual(fit);
    expect(drawnSize("fit-color", wide, frame)).toEqual(fit);
  });

  it("is the whole frame without a source (colour clips)", () => {
    expect(drawnSize("fill", null, frame)).toEqual(frame);
    expect(drawnSize("fit", { w: 0, h: 0 }, frame)).toEqual(frame);
  });

  it("swaps a source's size for quarter-turn rotations", () => {
    expect(displaySize({ width: 1920, height: 1080, rotation: 90 })).toEqual({ w: 1080, h: 1920 });
    expect(displaySize({ width: 1920, height: 1080, rotation: 180 })).toEqual({ w: 1920, h: 1080 });
    expect(displaySize({ width: 1920, height: 1080, rotation: -90 })).toEqual({ w: 1080, h: 1920 });
    expect(displaySize({ width: 0, height: 0 })).toBeNull();
  });
});

describe("box", () => {
  it("is centred with the identity transform and moves by the offset fractions", () => {
    const drawn = { w: 540, h: 960 };
    expect(boxFor(drawn, frame, { x: 0, y: 0, scale: 1, rotation: 0 })).toEqual({ cx: 270, cy: 480, w: 540, h: 960, rotation: 0 });
    expect(boxFor(drawn, frame, { x: 0.1, y: -0.25, scale: 2, rotation: 30 })).toEqual({ cx: 324, cy: 240, w: 1080, h: 1920, rotation: 30 });
  });

  it("maps local points to the canvas and back, with rotation", () => {
    const box = { cx: 300, cy: 400, w: 200, h: 100, rotation: 90 };
    near(boxToCanvas(box, { x: 100, y: 50 }), { x: 300, y: 400 });
    // the top-left corner rotates a quarter turn clockwise about the centre
    near(boxToCanvas(box, { x: 0, y: 0 }), { x: 350, y: 300 });
    for (const p of [{ x: 10, y: 20 }, { x: 200, y: 100 }, { x: -30, y: 70 }]) near(canvasToBox(box, boxToCanvas(box, p)), p);
    near(cornerPoint({ ...box, rotation: 0 }, "br"), { x: 400, y: 450 });
    const h = rotateHandle({ ...box, rotation: 0 }, 30);
    near(h.from, { x: 300, y: 350 });
    near(h.to, { x: 300, y: 320 });
  });
});

describe("handles", () => {
  it("scales uniformly with the distance from the centre", () => {
    const c = { x: 100, y: 100 };
    expect(scaleFromDrag(1, c, { x: 200, y: 100 }, { x: 300, y: 100 }, 0.05, 8)).toBeCloseTo(2);
    expect(scaleFromDrag(1.5, c, { x: 200, y: 100 }, { x: 150, y: 100 }, 0.05, 8)).toBeCloseTo(0.75);
    expect(scaleFromDrag(1, c, { x: 200, y: 100 }, { x: 100, y: 100 }, 0.05, 8)).toBe(0.05);
    expect(scaleFromDrag(1, c, { x: 200, y: 100 }, { x: 9000, y: 100 }, 0.05, 8)).toBe(8);
    expect(scaleFromDrag(3, c, c, { x: 5, y: 5 }, 0.05, 8)).toBe(3);
  });

  it("rotates by the angle swept around the centre", () => {
    const c = { x: 0, y: 0 };
    expect(angleDeg(c, { x: 0, y: -10 })).toBeCloseTo(0);
    expect(angleDeg(c, { x: 10, y: 0 })).toBeCloseTo(90);
    expect(rotationFromDrag(10, c, { x: 0, y: -10 }, { x: 10, y: 0 }, false)).toBeCloseTo(100);
    expect(rotationFromDrag(0, c, { x: 0, y: -10 }, { x: -10, y: 0 }, false)).toBeCloseTo(-90);
    // crossing the ±180 seam takes the short way
    expect(rotationFromDrag(0, c, { x: -1, y: 10 }, { x: 1, y: 10 }, false)).toBeCloseTo(-11.4, 0);
  });

  it("snaps angles near multiples of 45° and offsets near the centre line", () => {
    expect(snapAngle(2)).toBe(0);
    expect(snapAngle(43)).toBe(45);
    expect(snapAngle(20)).toBe(20);
    expect(snapAngle(-88)).toBe(-90);
    expect(rotationFromDrag(0, { x: 0, y: 0 }, { x: 0, y: -10 }, { x: 0.3, y: -10 })).toBe(0);
    expect(snapCentre(0.004, 0.01)).toEqual({ value: 0, snapped: true });
    expect(snapCentre(-0.02, 0.01)).toEqual({ value: -0.02, snapped: false });
  });
});

describe("masks", () => {
  const box = { cx: 270, cy: 480, w: 540, h: 960, rotation: 0 };

  it("maps path points through the mask's centre, scale and rotation, and back", () => {
    const m = { x: 0.5, y: 0.5, w: 1, h: 1, rotation: 0 };
    expect(maskLocalToBox(m, box, { x: 0.25, y: 0.75 })).toEqual({ x: 135, y: 720 });
    const m2 = { x: 0.6, y: 0.4, w: 0.5, h: 0.8, rotation: 33 };
    for (const p of [{ x: 0.3, y: 0.3 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.5 }]) {
      const back = boxToMaskLocal(m2, box, maskLocalToBox(m2, box, p));
      near(back, p);
    }
  });

  it("finds a rect mask's corners on the canvas", () => {
    const m = { x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0 };
    const c = maskCorners(m, box);
    near(c[0] as Pt, { x: 135, y: 240 });
    near(c[2] as Pt, { x: 405, y: 720 });
    const r = maskCorners({ ...m, rotation: 90 }, box);
    near(r[0] as Pt, { x: 510, y: 345 }); // (-135,-240) turned a quarter clockwise about the centre
  });

  it("derives size from a dragged corner around the centre", () => {
    const m = { x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0 };
    const s = maskSizeFromCorner(m, box, { x: 540, y: 960 });
    expect(s.w).toBeCloseTo(1);
    expect(s.h).toBeCloseTo(1);
    expect(maskSizeFromCorner(m, box, { x: 270, y: 480 }, 0.02)).toEqual({ w: 0.02, h: 0.02 });
    // a rotated mask is measured along its own axes
    const rot = { ...m, rotation: 90 };
    const corner = maskCorners(rot, box)[2] as Pt;
    const r = maskSizeFromCorner(rot, box, corner);
    expect(r.w).toBeCloseTo(0.5);
    expect(r.h).toBeCloseTo(0.5);
  });

  it("moves the centre by a canvas drag, through the clip's rotation", () => {
    expect(maskCentreFromDrag({ x: 0.5, y: 0.5 }, box, { x: 54, y: -96 })).toEqual({ x: 0.6, y: 0.4 });
    const r = maskCentreFromDrag({ x: 0.5, y: 0.5 }, { ...box, rotation: 90 }, { x: 0, y: 96 });
    expect(r.x).toBeCloseTo(0.5 + 96 / 540);
    expect(r.y).toBeCloseTo(0.5);
  });

  it("finds the nearest edge of a closed polygon", () => {
    const poly = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    expect(nearestEdge(poly, { x: 50, y: -4 })).toMatchObject({ index: 0, point: { x: 50, y: 0 }, distance: 4 });
    expect(nearestEdge(poly, { x: 3, y: 50 })).toMatchObject({ index: 3, point: { x: 0, y: 50 }, distance: 3 }); // the closing edge
    expect(nearestEdge([], { x: 0, y: 0 })).toBeNull();
  });
});

describe("safe zones", () => {
  it("shades the four edges for 9:16 and 4:5 only", () => {
    const z = safeZones("9:16", 540, 960);
    expect(z.map((r) => r.id)).toEqual(["top", "bottom", "left", "right"]);
    expect(z[0]).toMatchObject({ y: 0, h: 96, w: 540 });
    expect(z[1]).toMatchObject({ y: 960 - 211.2, h: 211.2 });
    expect(z[2]).toMatchObject({ w: 32.4, y: 96 });
    expect(z[3]?.w).toBeCloseTo(75.6);
    expect(z[3]?.x).toBeCloseTo(540 - 75.6);
    expect(safeZones("4:5", 540, 675)).toHaveLength(4);
    expect(safeZones("1:1", 540, 540)).toEqual([]);
    expect(safeZones("16:9", 960, 540)).toEqual([]);
  });
});

describe("rotatePt", () => {
  it("turns clockwise on screen", () => {
    near(rotatePt({ x: 10, y: 0 }, { x: 0, y: 0 }, 90), { x: 0, y: 10 });
  });
});

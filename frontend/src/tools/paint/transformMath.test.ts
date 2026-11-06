import { describe, expect, it } from "vitest";
import { apply, centreOf, compose, handlePoint, IDENTITY, invert, movePoint, rotateAbout, rotateDrag, scaleHandle, translate } from "./transformMath";

const R = { x: 10, y: 20, w: 100, h: 50 };
const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};

describe("transformMath", () => {
  it("composes and inverts", () => {
    const m = compose(translate(IDENTITY, 5, 7), [2, 0, 0, 3, 1, 1]);
    const inv = invert(m);
    expect(inv).not.toBeNull();
    close(apply(inv!, apply(m, { x: 13, y: -4 })), { x: 13, y: -4 });
    expect(invert([0, 0, 0, 0, 1, 1])).toBeNull();
  });

  it("dragging a corner scales around the opposite corner", () => {
    const m = scaleHandle(IDENTITY, R, { hx: 1, hy: 1 }, { x: 210, y: 120 }, false);
    close(handlePoint(m, R, { hx: 0, hy: 0 }), { x: 10, y: 20 });
    close(handlePoint(m, R, { hx: 1, hy: 1 }), { x: 210, y: 120 });
  });

  it("an edge handle scales one axis only", () => {
    const m = scaleHandle(IDENTITY, R, { hx: 1, hy: 0.5 }, { x: 310, y: 999 }, false);
    close(handlePoint(m, R, { hx: 1, hy: 0.5 }), { x: 310, y: 45 });
    close(handlePoint(m, R, { hx: 0, hy: 0 }), { x: 10, y: 20 });
  });

  it("uniform keeps the proportions", () => {
    const m = scaleHandle(IDENTITY, R, { hx: 1, hy: 1 }, { x: 210, y: 70 }, true);
    expect(m[0]).toBeCloseTo(m[3], 6);
  });

  it("scaling still works after a rotation", () => {
    const rot = rotateAbout(IDENTITY, centreOf(IDENTITY, R), Math.PI / 6);
    const anchor = handlePoint(rot, R, { hx: 0, hy: 0 });
    const target = handlePoint(rot, R, { hx: 1, hy: 1 });
    const m = scaleHandle(rot, R, { hx: 1, hy: 1 }, { x: target.x + 20, y: target.y + 20 }, false);
    close(handlePoint(m, R, { hx: 0, hy: 0 }), anchor);
  });

  it("rotating by a quarter turn about the centre keeps the centre", () => {
    const c = centreOf(IDENTITY, R);
    const m = rotateDrag(IDENTITY, R, { x: c.x + 10, y: c.y }, { x: c.x, y: c.y + 10 }, false);
    close(centreOf(m, R), c);
    close(apply(m, { x: c.x + 10, y: c.y }), { x: c.x, y: c.y + 10 });
  });

  it("snaps a rotation to 15 degrees", () => {
    const c = centreOf(IDENTITY, R);
    const to = { x: c.x + Math.cos(0.3) * 50, y: c.y + Math.sin(0.3) * 50 };
    const m = rotateDrag(IDENTITY, R, { x: c.x + 50, y: c.y }, to, true);
    expect(Math.atan2(m[1], m[0])).toBeCloseTo(Math.PI / 12, 6);
  });

  it("moves one point of a list without touching the others", () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    const out = movePoint(pts, 1, { x: 5, y: 6 });
    expect(out).toEqual([{ x: 0, y: 0 }, { x: 5, y: 6 }]);
    expect(pts[1]).toEqual({ x: 1, y: 1 });
  });
});

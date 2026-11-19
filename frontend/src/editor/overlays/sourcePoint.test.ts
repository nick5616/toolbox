import { describe, expect, it } from "vitest";
import { previewToSourceUV, sourceUVToPreview } from "./sourcePoint";

const frame = { w: 900, h: 1600 };
const drawn = { w: 900, h: 506.25 };
const id = { frame, drawn, x: 0, y: 0, scale: 1, rotation: 0 };

describe("previewToSourceUV", () => {
  it("the frame centre is the picture centre", () => {
    expect(previewToSourceUV({ ...id, point: { x: 450, y: 800 } })).toEqual({ u: 0.5, v: 0.5 });
  });
  it("corners of the fitted picture", () => {
    const top = 800 - 506.25 / 2;
    const tl = previewToSourceUV({ ...id, point: { x: 0, y: top } });
    expect(tl?.u).toBeCloseTo(0, 9);
    expect(tl?.v).toBeCloseTo(0, 9);
    const br = previewToSourceUV({ ...id, point: { x: 900, y: 800 + 506.25 / 2 } });
    expect(br?.u).toBeCloseTo(1, 9);
    expect(br?.v).toBeCloseTo(1, 9);
  });
  it("outside the picture (the bars) is null", () => {
    expect(previewToSourceUV({ ...id, point: { x: 450, y: 100 } })).toBeNull();
  });
  it("follows scale and offset", () => {
    const i = { ...id, scale: 0.5, x: 0.25, y: -0.25 };
    // centre of the scaled picture is at (450 + 225, 800 - 400)
    const uv = previewToSourceUV({ ...i, point: { x: 675, y: 400 } });
    expect(uv?.u).toBeCloseTo(0.5, 9);
    expect(uv?.v).toBeCloseTo(0.5, 9);
    // its right edge is half of 450 px further
    const edge = previewToSourceUV({ ...i, point: { x: 675 + 225 - 1, y: 400 } });
    expect(edge?.u).toBeGreaterThan(0.99);
  });
  it("follows rotation (clockwise on screen)", () => {
    const i = { ...id, drawn: { w: 900, h: 900 }, rotation: 90 };
    // rotating 90° clockwise puts the picture's top edge on the right of the centre
    const uv = previewToSourceUV({ ...i, point: { x: 450 + 400, y: 800 } });
    expect(uv?.u).toBeCloseTo(0.5, 9);
    expect(uv?.v).toBeCloseTo(0.5 - 400 / 900, 9);
  });
  it("flip mirrors u; crop makes the cut-off part null", () => {
    const left = { x: 450 - 300, y: 800 };
    expect(previewToSourceUV({ ...id, point: left, flipX: true })?.u).toBeCloseTo(1 - (450 - 300) / 900, 9);
    expect(previewToSourceUV({ ...id, point: left, crop: [0.4, 0, 0, 0] })).toBeNull();
    expect(previewToSourceUV({ ...id, point: { x: 450, y: 800 }, crop: [0.4, 0, 0, 0] })).not.toBeNull();
  });
  it("is the inverse of sourceUVToPreview", () => {
    const i = { frame, drawn, x: 0.1, y: -0.05, scale: 0.7, rotation: 23 };
    for (const uv of [{ u: 0.2, v: 0.3 }, { u: 0.9, v: 0.8 }, { u: 0.5, v: 0.5 }]) {
      const p = sourceUVToPreview(i, uv);
      const back = previewToSourceUV({ ...i, point: p });
      expect(back?.u).toBeCloseTo(uv.u, 9);
      expect(back?.v).toBeCloseTo(uv.v, 9);
    }
  });
});

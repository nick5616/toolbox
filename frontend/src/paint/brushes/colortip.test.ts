// Colour tips (Subject stamp): a "stamp:<layer>" tip paints its own colours, the
// current colour only tints it, and flow/opacity still scale it. CPU backend.
import { describe, expect, it } from "vitest";
import type { AssetImage } from "./assets";
import { pt, px, strokeLine, testBrush, testEngine } from "../engine/testing";
import type { RGBA, ToolState } from "../engine/types";

const GREEN: RGBA = { r: 0, g: 1, b: 0, a: 1 };

/** 16×16: left half red, right half blue, the top row transparent. */
function stamp(): AssetImage {
  const w = 16;
  const data = new Uint8ClampedArray(w * w * 4);
  for (let y = 1; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = x < 8 ? 255 : 0;
      data[i + 2] = x < 8 ? 0 : 255;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: w };
}

async function dab(tint: number, flow = 1) {
  const e = await testEngine(64, 64, { resolver: (ref) => (ref === "stamp:cat" ? stamp() : null) });
  const brush = testBrush({ size: 16, spacing: 5, flow, tip: { shape: "stamp:cat", hardness: tint, roundness: 1, angle: 0, angleMode: "fixed", rotationJitter: 0, invert: false } });
  await e.prepareBrush(brush);
  const tool: ToolState = { kind: "brush", brush, color: GREEN, secondary: GREEN, seed: 3 };
  strokeLine(e, tool, [pt(32, 32)]);
  return e;
}

describe("colour tips", () => {
  it("paint the stamp's own colours with hardness 0", async () => {
    const e = await dab(0);
    const [r1, g1, b1, a1] = await px(e, 28, 33);
    const [r2, g2, b2, a2] = await px(e, 36, 33);
    expect([r1, g1, b1, a1]).toEqual([255, 0, 0, 255]);
    expect([r2, g2, b2, a2]).toEqual([0, 0, 255, 255]);
  });

  it("leave transparent texels unpainted", async () => {
    const e = await dab(0);
    expect((await px(e, 28, 24))[3]).toBe(0); // the stamp's transparent top row
  });

  it("tint toward the current colour: hardness 1 is the silhouette in it", async () => {
    const silhouette = await dab(1);
    expect(await px(silhouette, 28, 33)).toEqual([0, 255, 0, 255]);
    expect(await px(silhouette, 36, 33)).toEqual([0, 255, 0, 255]);
    const half = await dab(0.5);
    const [r, g, b] = await px(half, 28, 33);
    expect(Math.abs(r - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - 128)).toBeLessThanOrEqual(1);
    expect(b).toBe(0);
  });

  it("scale with flow", async () => {
    const e = await dab(0, 0.5);
    const [r, g, b, a] = await px(e, 28, 33);
    expect(a).toBeGreaterThan(120);
    expect(a).toBeLessThan(136);
    expect([r, g, b]).toEqual([255, 0, 0]); // straight colour is unchanged by the alpha
  });

  it("are deterministic", async () => {
    const a = await dab(0.25);
    const b = await dab(0.25);
    const ra = (await a.readRegion({ x: 20, y: 20, w: 24, h: 24 }, "layer")).data;
    const rb = (await b.readRegion({ x: 20, y: 20, w: 24, h: 24 }, "layer")).data;
    expect(Array.from(ra)).toEqual(Array.from(rb));
  });
});

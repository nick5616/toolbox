import { describe, expect, it } from "vitest";
import { makeImageData } from "../engine/pixels";
import { RED, line, strokeLine, testBrush, testEngine } from "../engine/testing";
import { AdjustSession, LiquifyField, colorBalance, curves, gaussianBlur, gradientMap, hsb, motionBlur, noise, sharpen } from "./index";

function solid(w: number, h: number, c: [number, number, number, number]): ImageData {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set(c, i * 4);
  return makeImageData(w, h, d);
}
const at = (img: ImageData, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe("adjustments", () => {
  it("hsb shifts hue and leaves transparent pixels alone", () => {
    const img = solid(2, 1, [255, 0, 0, 255]);
    img.data.set([0, 0, 0, 0], 4);
    const out = hsb(img, { hue: 120, saturation: 0, brightness: 0 });
    expect(at(out, 0, 0)).toEqual([0, 255, 0, 255]);
    expect(at(out, 1, 0)).toEqual([0, 0, 0, 0]);
    expect(at(img, 0, 0)).toEqual([255, 0, 0, 255]); // input untouched
    expect(at(hsb(img, { hue: 0, saturation: -1, brightness: 0 }), 0, 0)[0]).toBe(at(hsb(img, { hue: 0, saturation: -1, brightness: 0 }), 0, 0)[1]);
  });

  it("colour balance pushes shadows, curves invert, gradient map recolours", () => {
    const dark = solid(1, 1, [20, 20, 20, 255]);
    expect(at(colorBalance(dark, { shadows: [1, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: false }), 0, 0)[0]).toBeGreaterThan(20);
    const inv = curves(solid(1, 1, [255, 100, 0, 255]), { master: [[0, 1], [1, 0]] });
    expect(at(inv, 0, 0)).toEqual([0, 155, 255, 255]);
    const gm = gradientMap(solid(2, 1, [0, 0, 0, 255]), [{ pos: 0, r: 0, g: 0, b: 1 }, { pos: 1, r: 1, g: 0, b: 0 }]);
    expect(at(gm, 0, 0)).toEqual([0, 0, 255, 255]);
  });

  it("blurs spread without darkening transparent edges, and noise is seeded", () => {
    const img = solid(9, 9, [0, 0, 0, 0]);
    img.data.set([255, 0, 0, 255], (4 * 9 + 4) * 4);
    const b = gaussianBlur(img, 1.5);
    const c = at(b, 3, 4);
    expect(c[3]).toBeGreaterThan(0);
    expect(c[0]).toBe(255); // straight colour stays red
    expect(at(motionBlur(img, 0, 5), 3, 4)[3]).toBeGreaterThan(0);
    expect(at(motionBlur(img, 0, 5), 4, 1)[3]).toBe(0);
    const s = sharpen(solid(4, 4, [100, 100, 100, 255]), 1, 1);
    expect(at(s, 1, 1)).toEqual([100, 100, 100, 255]);
    const n1 = noise(solid(4, 4, [128, 128, 128, 255]), { amount: 0.5, mono: false, seed: 3 });
    const n2 = noise(solid(4, 4, [128, 128, 128, 255]), { amount: 0.5, mono: false, seed: 3 });
    const n3 = noise(solid(4, 4, [128, 128, 128, 255]), { amount: 0.5, mono: false, seed: 4 });
    expect(Array.from(n1.data)).toEqual(Array.from(n2.data));
    expect(Array.from(n1.data)).not.toEqual(Array.from(n3.data));
  });

  it("liquify moves pixels (push) deterministically", () => {
    const img = solid(32, 8, [0, 0, 0, 0]);
    for (let y = 0; y < 8; y++) img.data.set([255, 0, 0, 255], (y * 32 + 8) * 4);
    const run = (mode: "push" | "twirl" | "pinch" | "expand" | "crystals") => {
      const f = new LiquifyField(32, 8, 5);
      f.dab(mode, 10, 4, 8, 1, 6, 0);
      return f.apply(img);
    };
    const pushed = run("push");
    expect(at(pushed, 11, 4)[3]).toBeGreaterThan(0); // the line moved right
    for (const m of ["twirl", "pinch", "expand", "crystals"] as const) expect(Array.from(run(m).data)).toEqual(Array.from(run(m).data));
  });
});

describe("adjust session", () => {
  it("previews without history, commits as one step, and supports pencil mode", async () => {
    const e = await testEngine(32, 32);
    strokeLine(e, { kind: "brush", brush: testBrush({ size: 12 }), color: RED, secondary: RED, seed: 1 }, line(5, 16, 27, 16));
    const before = e.history().length;
    const s = AdjustSession.begin(e, "Hue")!;
    s.preview((img) => hsb(img, { hue: 120, saturation: 0, brightness: 0 }));
    expect(e.history()).toHaveLength(before);
    expect((await e.readRegion({ x: 16, y: 16, w: 1, h: 1 }, "layer")).data[1]).toBe(255);
    s.preview((img) => hsb(img, { hue: 240, saturation: 0, brightness: 0 }));
    expect((await e.readRegion({ x: 16, y: 16, w: 1, h: 1 }, "layer")).data[2]).toBe(255);
    s.commit();
    expect(e.history()).toHaveLength(before + 1);
    e.undo();
    expect((await e.readRegion({ x: 16, y: 16, w: 1, h: 1 }, "layer")).data[0]).toBe(255);

    // Pencil: apply through a painted mask only.
    const p = AdjustSession.begin(e, "Hue")!;
    p.render((img) => hsb(img, { hue: 120, saturation: 0, brightness: 0 }));
    const mask = makeImageData(8, 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 8; x++) mask.data[(y * 8 + x) * 4 + 3] = 255;
    p.applyThroughMask(mask, { x: 0, y: 0 });
    expect((await e.readRegion({ x: 6, y: 16, w: 1, h: 1 }, "layer")).data[1]).toBe(255);
    expect((await e.readRegion({ x: 20, y: 16, w: 1, h: 1 }, "layer")).data[0]).toBe(255);
  });

  it("cancel restores the layer", async () => {
    const e = await testEngine(16, 16);
    strokeLine(e, { kind: "brush", brush: testBrush({ size: 10 }), color: RED, secondary: RED, seed: 1 }, [{ x: 8, y: 8, pressure: 1, tiltX: 0, tiltY: 0, twist: 0, t: 0, pointer: "pen" }]);
    const s = AdjustSession.begin(e)!;
    s.preview((img) => hsb(img, { hue: 120, saturation: 0, brightness: 0 }));
    s.cancel();
    expect((await e.readRegion({ x: 8, y: 8, w: 1, h: 1 }, "layer")).data[0]).toBe(255);
  });
});

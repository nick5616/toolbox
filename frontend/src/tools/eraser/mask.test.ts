import { describe, expect, it } from "vitest";
import {
  BRUSH_MAX,
  BRUSH_MIN,
  FIT_VIEW,
  MaskHistory,
  UNDO_STEPS,
  actualSizeZoom,
  brushToMask,
  capSize,
  clampBrush,
  clientToMask,
  exportSize,
  fitScale,
  maskIsEmpty,
  maskSize,
  zoomAround,
  type Stroke,
} from "./mask";
import { modelHint, sanitizeSettings, DEFAULT_SETTINGS, canPaintOn } from "./options";

const brush = (n = 0): Stroke => ({ kind: "brush", size: 10, points: [{ x: n, y: n }] });

describe("sizes", () => {
  it("caps the long side without upscaling", () => {
    expect(capSize(1000, 500, 4096)).toEqual({ w: 1000, h: 500 });
    expect(capSize(8192, 4096, 4096)).toEqual({ w: 4096, h: 2048 });
    expect(capSize(3000, 6000, 4096)).toEqual({ w: 2048, h: 4096 });
  });

  it("paints at most 4096 but exports the natural size up to 8192", () => {
    expect(maskSize(6000, 4000)).toEqual({ w: 4096, h: 2731 });
    expect(exportSize(6000, 4000)).toEqual({ w: 6000, h: 4000 });
    expect(exportSize(12000, 6000)).toEqual({ w: 8192, h: 4096 });
  });

  it("keeps the aspect ratio within the backend's 1% tolerance", () => {
    const m = maskSize(5472, 3648);
    expect(Math.abs(m.w / m.h - 5472 / 3648)).toBeLessThan(0.01 * (5472 / 3648));
  });
});

describe("coordinates", () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 };
  const mask = { w: 4000, h: 2000 };

  it("maps client points to mask pixels", () => {
    expect(clientToMask(100, 50, rect, mask)).toEqual({ x: 0, y: 0 });
    expect(clientToMask(300, 150, rect, mask)).toEqual({ x: 2000, y: 1000 });
    expect(clientToMask(500, 250, rect, mask)).toEqual({ x: 4000, y: 2000 });
  });

  it("scales the brush from screen px to mask px", () => {
    expect(brushToMask(40, rect, mask)).toBe(400);
    expect(brushToMask(40, { ...rect, width: 0 }, mask)).toBe(40);
  });

  it("clamps the brush size to 4..300", () => {
    expect(clampBrush(1)).toBe(BRUSH_MIN);
    expect(clampBrush(999)).toBe(BRUSH_MAX);
    expect(clampBrush(40.4)).toBe(40);
  });
});

describe("zoom", () => {
  it("fits the image into the container", () => {
    expect(fitScale({ w: 800, h: 600 }, { w: 1600, h: 600 })).toBe(0.5);
    expect(fitScale({ w: 0, h: 0 }, { w: 10, h: 10 })).toBe(1);
  });

  it("keeps the point under the cursor fixed", () => {
    const v = zoomAround(FIT_VIEW, 2, 100, 50);
    expect(v.zoom).toBe(2);
    expect(v.panX).toBe(-100);
    expect(v.panY).toBe(-50);
  });

  it("clamps zoom and computes 100%", () => {
    expect(zoomAround(FIT_VIEW, 1000, 0, 0).zoom).toBe(32);
    expect(zoomAround(FIT_VIEW, 0.0001, 0, 0).zoom).toBe(0.25);
    expect(actualSizeZoom({ w: 500, h: 500 }, { w: 1000, h: 1000 })).toBe(2);
  });
});

describe("MaskHistory", () => {
  it("undoes and redoes strokes", () => {
    const h = new MaskHistory();
    h.push(brush(1));
    h.push(brush(2));
    expect(h.strokes()).toHaveLength(2);
    expect(h.undo()).toBe(true);
    expect(h.strokes()).toHaveLength(1);
    expect(h.canRedo).toBe(true);
    expect(h.redo()).toBe(true);
    expect(h.strokes()).toHaveLength(2);
    expect(h.canRedo).toBe(false);
  });

  it("drops the redo stack on a new stroke", () => {
    const h = new MaskHistory();
    h.push(brush(1));
    h.undo();
    h.push(brush(2));
    expect(h.canRedo).toBe(false);
    expect(h.redo()).toBe(false);
  });

  it("allows only 50 undo steps", () => {
    const h = new MaskHistory();
    for (let i = 0; i < 60; i++) h.push(brush(i));
    let n = 0;
    while (h.undo()) n++;
    expect(n).toBe(UNDO_STEPS);
    // The oldest 10 strokes are baked in.
    expect(h.strokes()).toHaveLength(10);
  });

  it("replays from the last clear, and undo restores what clear removed", () => {
    const h = new MaskHistory();
    h.push(brush(1));
    h.push({ kind: "clear" });
    expect(h.strokes()).toHaveLength(0);
    expect(h.hasPaint).toBe(false);
    h.push(brush(2));
    expect(h.strokes()).toHaveLength(1);
    h.undo();
    h.undo(); // undo the clear
    expect(h.strokes()).toHaveLength(1);
    expect(h.hasPaint).toBe(true);
  });

  it("reports paint only for brush strokes", () => {
    const h = new MaskHistory();
    expect(h.hasPaint).toBe(false);
    h.push({ kind: "unpaint", size: 5, points: [{ x: 0, y: 0 }] });
    expect(h.hasPaint).toBe(false);
    h.push(brush());
    expect(h.hasPaint).toBe(true);
    h.reset();
    expect(h.canUndo).toBe(false);
    expect(h.hasPaint).toBe(false);
  });
});

describe("maskIsEmpty", () => {
  it("looks only at alpha", () => {
    expect(maskIsEmpty(new Uint8ClampedArray([255, 255, 255, 0, 9, 9, 9, 0]))).toBe(true);
    expect(maskIsEmpty(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 1]))).toBe(false);
  });
});

describe("options", () => {
  it("sanitises saved settings", () => {
    expect(sanitizeSettings({ model: "fast", brush: 9999 }, DEFAULT_SETTINGS)).toEqual({ model: "fast", brush: 300 });
    expect(sanitizeSettings({ model: "nope", brush: "x" }, DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(null, DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it("builds the model hint", () => {
    expect(modelHint([])).toBe("Best · 208 MB · Fast · 28 MB");
    const mb = 1024 * 1024;
    expect(
      modelHint([
        { id: "best", label: "Best", downloadBytes: 200 * mb },
        { id: "fast", label: "Fast", downloadBytes: 30 * mb },
      ]),
    ).toBe("Best · 200 MB · Fast · 30 MB");
  });

  it("only paints on webview-displayable formats", () => {
    expect(canPaintOn("/a/b.JPG")).toBe(true);
    expect(canPaintOn("/a/b.heic")).toBe(false);
    expect(canPaintOn("/a/b.tiff")).toBe(false);
  });
});

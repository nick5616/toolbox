import { describe, expect, it } from "vitest";
import { drawnSize } from "../overlays/overlayGeometry";
import { frameOfAspect, PIP_PRESETS, pipValues } from "./pip";

describe("picture-in-picture presets", () => {
  it("ships the eight presets of §B4", () => {
    expect(PIP_PRESETS.map((p) => p.id)).toEqual(["full", "tl", "tr", "bl", "br", "centre", "left", "right"]);
  });
  it("frames from an aspect string", () => {
    expect(frameOfAspect("9:16")).toEqual({ w: 900, h: 1600 });
    expect(frameOfAspect("nonsense")).toEqual({ w: 1600, h: 900 });
  });

  describe("16:9 frame, 16:9 clip", () => {
    const frame = frameOfAspect("16:9"); // 1600 x 900
    const img = drawnSize("fit", { w: 1920, h: 1080 }, frame);
    it("full is the identity", () => {
      expect(pipValues("full", frame, img)).toEqual({ x: 0, y: 0, scale: 1 });
    });
    it("top left at 30% with a 4% margin", () => {
      const v = pipValues("tl", frame, img);
      expect(v.scale).toBeCloseTo(0.3, 9);
      // margin 36 px (4% of the short side); picture 480 x 270
      expect(v.x).toBeCloseTo((36 + 240 - 800) / 1600, 9);
      expect(v.y).toBeCloseTo((36 + 135 - 450) / 900, 9);
    });
    it("the four corners mirror each other", () => {
      const tl = pipValues("tl", frame, img);
      const br = pipValues("br", frame, img);
      const tr = pipValues("tr", frame, img);
      const bl = pipValues("bl", frame, img);
      expect(br.x).toBeCloseTo(-tl.x, 9);
      expect(br.y).toBeCloseTo(-tl.y, 9);
      expect(tr.x).toBeCloseTo(-tl.x, 9);
      expect(tr.y).toBeCloseTo(tl.y, 9);
      expect(bl.x).toBeCloseTo(tl.x, 9);
      expect(bl.y).toBeCloseTo(-tl.y, 9);
    });
    it("centre is half size; halves fit into half the frame", () => {
      expect(pipValues("centre", frame, img)).toEqual({ x: 0, y: 0, scale: 0.5 });
      const l = pipValues("left", frame, img);
      expect(l.x).toBe(-0.25);
      expect(l.scale).toBeCloseTo(0.5, 9); // width 800 of 1600
      expect(pipValues("right", frame, img).x).toBe(0.25);
    });
  });

  describe("9:16 frame, 16:9 clip (fit)", () => {
    const frame = frameOfAspect("9:16"); // 900 x 1600
    const img = drawnSize("fit", { w: 1920, h: 1080 }, frame); // 900 x 506.25
    it("30% of the fitted frame, inside the margin", () => {
      const v = pipValues("br", frame, img);
      expect(v.scale).toBeCloseTo(0.3, 9);
      const hw = (img.w * v.scale) / 2;
      const hh = (img.h * v.scale) / 2;
      expect(v.x).toBeCloseTo((900 - 36 - hw - 450) / 900, 9);
      expect(v.y).toBeCloseTo((1600 - 36 - hh - 800) / 1600, 9);
      // the picture's right and bottom edges sit exactly one margin inside the frame
      expect(450 + v.x * 900 + hw).toBeCloseTo(900 - 36, 9);
      expect(800 + v.y * 1600 + hh).toBeCloseTo(1600 - 36, 9);
    });
    it("a half preset fits the picture into the half", () => {
      const v = pipValues("left", frame, img);
      expect(v.scale).toBeCloseTo(0.5, 9); // 450 of 900 wide
    });
  });

  it("a portrait clip in a landscape frame is sized by height, not blown up", () => {
    const frame = frameOfAspect("16:9");
    const img = drawnSize("fit", { w: 1080, h: 1920 }, frame); // 506.25 x 900
    const v = pipValues("tl", frame, img);
    expect(v.scale).toBeCloseTo(0.3, 9);
    expect(v.scale * img.h).toBeCloseTo(270, 6);
  });

  it("a fill clip (larger than the frame) shrinks its whole picture to the same 30% width", () => {
    const frame = frameOfAspect("9:16");
    const img = drawnSize("fill", { w: 1920, h: 1080 }, frame); // cover: 2844 x 1600
    const v = pipValues("tl", frame, img);
    expect(v.scale * img.w).toBeCloseTo(0.3 * 900, 6);
  });
});

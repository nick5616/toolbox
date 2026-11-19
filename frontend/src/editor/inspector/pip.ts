/**
 * Picture-in-picture presets (Phase 21 SPEC §B4). Pure: from the frame and the
 * clip's fitted picture size, the x, y (fractions of the frame's width and
 * height, the clip's centre offset) and scale (× the fitted size) that put the
 * picture in a corner, the centre or one half.
 *
 * A preset's size is relative to the picture fitted whole into the frame (the
 * "fit" scale), so 30 % means the same on every source shape: a landscape clip
 * in a portrait frame and a fill clip both end up a third of the frame.
 */
import type { Size } from "../overlays/overlayGeometry";

export type PipPresetId = "full" | "tl" | "tr" | "bl" | "br" | "centre" | "left" | "right";

export interface PipPreset {
  id: PipPresetId;
  label: string;
  tip: string;
}

export const PIP_PRESETS: readonly PipPreset[] = [
  { id: "full", label: "Full", tip: "Fill the frame with the clip (scale 1, centred)" },
  { id: "tl", label: "Top left", tip: "A small picture-in-picture in the top-left corner" },
  { id: "tr", label: "Top right", tip: "A small picture-in-picture in the top-right corner" },
  { id: "bl", label: "Bottom left", tip: "A small picture-in-picture in the bottom-left corner" },
  { id: "br", label: "Bottom right", tip: "A small picture-in-picture in the bottom-right corner" },
  { id: "centre", label: "Centre", tip: "Half size, in the middle of the frame" },
  { id: "left", label: "Left half", tip: "Fit the clip into the left half of the frame" },
  { id: "right", label: "Right half", tip: "Fit the clip into the right half of the frame" },
];

/** Corner presets' size (of the frame) and margin (of the frame's short side). */
export const PIP_CORNER_SIZE = 0.3;
export const PIP_MARGIN = 0.04;
export const PIP_CENTRE_SIZE = 0.5;

export interface PipValues {
  x: number;
  y: number;
  scale: number;
}

/** "9:16" → a frame size with that shape (only the ratio matters). */
export function frameOfAspect(aspect: string): Size {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect);
  const w = m ? Number(m[1]) : 16;
  const h = m ? Number(m[2]) : 9;
  return w > 0 && h > 0 ? { w: w * 100, h: h * 100 } : { w: 1600, h: 900 };
}

/** The scale that fits the picture whole into a (boxW × boxH) area. */
function fitScale(img: Size, boxW: number, boxH: number): number {
  return Math.min(boxW / Math.max(1, img.w), boxH / Math.max(1, img.h));
}

/** x, y and scale for a preset. `img` is the clip's picture size before the transform (`drawnSize`). */
export function pipValues(id: PipPresetId, frame: Size, img: Size): PipValues {
  const full = fitScale(img, frame.w, frame.h);
  switch (id) {
    case "full":
      return { x: 0, y: 0, scale: 1 };
    case "centre":
      return { x: 0, y: 0, scale: PIP_CENTRE_SIZE * full };
    case "left":
      return { x: -0.25, y: 0, scale: fitScale(img, frame.w / 2, frame.h) };
    case "right":
      return { x: 0.25, y: 0, scale: fitScale(img, frame.w / 2, frame.h) };
    default: {
      const scale = PIP_CORNER_SIZE * full;
      const margin = PIP_MARGIN * Math.min(frame.w, frame.h);
      const hw = (img.w * scale) / 2;
      const hh = (img.h * scale) / 2;
      const left = id === "tl" || id === "bl";
      const top = id === "tl" || id === "tr";
      const cx = left ? margin + hw : frame.w - margin - hw;
      const cy = top ? margin + hh : frame.h - margin - hh;
      return { x: (cx - frame.w / 2) / frame.w, y: (cy - frame.h / 2) / frame.h, scale };
    }
  }
}

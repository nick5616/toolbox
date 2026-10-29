import type { ContentRect } from "./types";

export interface CropOverlayProps {
  rect: ContentRect;
  /** Target width / height, e.g. 9/16. */
  aspect: number;
  /** Source width / height (display size). */
  sourceAspect: number;
  /** Centre of the window, 0..1. */
  x: number;
  y: number;
  onChange: (x: number, y: number) => void;
}

/** A draggable crop window with the outside dimmed (SPEC.md §3.11). UI-M implements it. */
export function CropOverlay(_props: CropOverlayProps) {
  return null;
}

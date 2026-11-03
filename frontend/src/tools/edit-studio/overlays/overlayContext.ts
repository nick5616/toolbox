/** What the overlay layers share: the selected clip, its drawn box at the playhead, and pointer conversion. */
import type { EditClip, EditSourceState } from "@/lib/api";
import { parseTransform, TRANSFORM_RULES } from "@/viz/edit/schema";
import { valueAt } from "../inspector/paramOps";
import { boxFor, displaySize, drawnSize, type Box, type Pt, type Size, type TransformValues } from "./overlayGeometry";

export interface OverlayCtx {
  clip: EditClip;
  frame: Size;
  /** Canvas pixels per CSS pixel (handle sizes use it to stay the same on screen). */
  k: number;
  /** The playhead in the clip's time. */
  clipMs: number;
  drawn: Size;
  values: TransformValues;
  /** The clip's drawn box at the playhead. */
  box: Box;
  toCanvas(e: { clientX: number; clientY: number }): Pt;
}

/** The size of a clip's source as the preview shows it, or null (colour and adjustment clips, unread sources). */
export function sourceSize(clip: EditClip, src: EditSourceState | undefined): Size | null {
  if (clip.kind !== "video" && clip.kind !== "image") return null;
  if (!src) return null;
  const fromInfo = displaySize({ width: src.info?.width ?? 0, height: src.info?.height ?? 0, rotation: src.info?.rotation ?? 0 });
  if (fromInfo) return fromInfo;
  const s = src.preview;
  return s && s.width > 0 && s.height > 0 ? { w: s.width, h: s.height } : null;
}

/** The transform values (reactions ignored) at the clip's playhead time. */
export function transformAt(raw: string, clipMs: number): TransformValues {
  const t = parseTransform(raw).value;
  const v = (k: keyof typeof TRANSFORM_RULES) => valueAt(t[k], TRANSFORM_RULES[k].min, TRANSFORM_RULES[k].max, clipMs);
  return { x: v("x"), y: v("y"), scale: v("scale"), rotation: v("rotation") };
}

export function buildCtx(clip: EditClip, src: EditSourceState | undefined, frame: Size, k: number, playheadMs: number, toCanvas: OverlayCtx["toCanvas"]): OverlayCtx {
  const clipMs = Math.round(playheadMs - clip.startMs);
  const drawn = drawnSize(clip.fit, sourceSize(clip, src), frame);
  const values = transformAt(clip.transform, clipMs);
  return { clip, frame, k, clipMs, drawn, values, box: boxFor(drawn, frame, values), toCanvas };
}

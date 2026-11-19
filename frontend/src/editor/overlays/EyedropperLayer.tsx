/**
 * The key-colour eyedropper (Phase 21 SPEC §B4). While armed (the "Pick" button
 * beside a chroma key's colour), a click on the preview maps to the clip's own
 * source picture (inverse of fit, transform and crop) and the engine's
 * `samplePre` returns the 5 × 5 average of the pre-effect pixel there; that
 * becomes the effect's colour. Esc or a click outside the picture cancels.
 */
import { useEffect, type PointerEvent as RPointerEvent } from "react";
import { parseEffects, serializeEffects } from "@/viz/edit/schema";
import { rgbToHex, samplePre } from "@/viz/edit/preSampler";
import { currentClip, patchClip } from "../inspector/inspectorState";
import { cropAt, type OverlayCtx } from "./overlayContext";
import { useOverlayMode, type PickTarget } from "./overlayMode";
import { previewToSourceUV } from "./sourcePoint";
import styles from "./overlays.module.css";

/** Writes a colour into one effect's parameter of a clip. */
export function setEffectColour(t: PickTarget, hex: string): void {
  const cur = currentClip(t.clipId);
  if (!cur) return;
  const effects = parseEffects(cur.effects).value.map((p) => (p.id === t.postId ? { ...p, params: { ...p.params, [t.param]: hex } } : p));
  patchClip(t.clipId, { effects: serializeEffects(effects) }, "");
}

export function EyedropperLayer({ ctx, target }: { ctx: OverlayCtx; target: PickTarget }) {
  const { clip, frame } = ctx;
  const endPick = useOverlayMode((s) => s.endPick);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") endPick();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [endPick]);

  const click = (e: RPointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const uv = previewToSourceUV({
      point: ctx.toCanvas(e),
      frame,
      drawn: ctx.drawn,
      x: ctx.values.x,
      y: ctx.values.y,
      scale: ctx.values.scale,
      rotation: ctx.values.rotation,
      crop: cropAt(clip.transform, ctx.clipMs),
      flipX: clip.flipX,
    });
    if (!uv) {
      endPick("Click on the clip's picture, not outside it.");
      return;
    }
    const rgb = samplePre(clip.id, uv.u, uv.v);
    if (!rgb) {
      endPick("The picture isn't ready to sample yet; try again in a moment.");
      return;
    }
    setEffectColour(target, rgbToHex(rgb));
    endPick();
  };

  return <rect data-testid="eyedropper" className={styles.pickLayer} x={0} y={0} width={frame.w} height={frame.h} data-tip="Click the colour to key out. Esc cancels." onPointerDown={click} />;
}

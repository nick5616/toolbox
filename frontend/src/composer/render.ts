import type { Composition } from "@/lib/api";

// The Photo Composer's renderer (SPEC.md Part B §B5.2). FROZEN signature
// (Wave B0): the editor and the export both draw with renderComposition, so
// what you see is what's saved. WP-CO1 implements it; the stub draws the
// background colour only.

/** Any 2D context the renderer can draw on (on-screen or offscreen). */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Decoded source images by path (from ComposerService.LoadImage). */
export type ImageMap = ReadonlyMap<string, ImageBitmap | HTMLImageElement>;

export interface RenderOptions {
  /** Output pixels per document pixel (1 = Width×Height). */
  scale: number;
  /** Draw editor-only hints (none yet; selection is drawn by the stage, not here). */
  editor?: boolean;
}

/**
 * Draws doc onto ctx, whose canvas is doc.width×scale by doc.height×scale.
 * Missing images are skipped (drawn as nothing). Deterministic for the same
 * inputs and scale.
 */
export function renderComposition(ctx: Ctx2D, doc: Composition, images: ImageMap, opts: RenderOptions): void {
  void images;
  const w = doc.width * opts.scale;
  const h = doc.height * opts.scale;
  ctx.save();
  ctx.fillStyle = doc.background.color || "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** The source paths a document needs loaded (background + image layers). */
export function imagePaths(doc: Composition): string[] {
  const out = new Set<string>();
  if (doc.background.kind === "image" && doc.background.image?.path) out.add(doc.background.image.path);
  for (const l of doc.layers ?? []) if (l.kind === "image" && l.image?.ref.path) out.add(l.image.ref.path);
  return [...out];
}

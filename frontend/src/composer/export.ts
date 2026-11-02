import type { Composition } from "@/lib/api";
import { ComposerService } from "@/lib/api";
import { EXPORT_DIM, loadImage } from "./loadImages";
import { clearRenderCache, renderBackground, renderLayer, type Ctx2D, type ImageMap } from "./render";

// Renders a composition for good and stores it in Go (SPEC.md Part B §B5.2,
// §B5.4). Images are loaded at 4096 one layer at a time, so a 20-photo
// composition never holds 20 full-size bitmaps.

/** Base64 of bytes, chunked so large renders don't overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

export interface ExportResult {
  format: "jpg" | "png";
  bytes: number;
  width: number;
  height: number;
}

export interface ExportOptions {
  /** Called as each layer is drawn (0..1). */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * Renders doc at scale (1 = Width×Height) on an OffscreenCanvas, encodes it
 * (JPEG q0.92 or PNG per doc.format) and stores it with
 * ComposerService.SaveRender(projectId, …).
 */
export async function exportComposition(projectId: string, doc: Composition, scale = 1, opts: ExportOptions = {}): Promise<ExportResult> {
  const format: "jpg" | "png" = doc.format === "png" ? "png" : "jpg";
  const width = Math.round(doc.width * scale);
  const height = Math.round(doc.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d") as Ctx2D | null;
  if (!ctx) throw new Error("2D canvas is not available");

  const check = (): void => {
    if (opts.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
  };

  const bgPath = doc.background.kind === "image" ? doc.background.image?.path : undefined;
  const bgImages = new Map<string, ImageBitmap>();
  if (bgPath) bgImages.set(bgPath, await loadImage(bgPath, EXPORT_DIM));
  check();
  renderBackground(ctx, doc, bgImages, scale);
  bgImages.clear();

  const layers = doc.layers ?? [];
  for (let i = 0; i < layers.length; i++) {
    check();
    const layer = layers[i];
    if (!layer || layer.hidden) continue;
    const images = new Map<string, ImageBitmap>();
    const path = layer.kind === "image" ? layer.image?.ref.path : undefined;
    if (path) images.set(path, await loadImage(path, EXPORT_DIM));
    renderLayer(ctx, doc, layer, images as ImageMap, scale);
    opts.onProgress?.((i + 1) / layers.length);
  }
  check();
  clearRenderCache(); // 4096 px sprites would otherwise crowd the editor's cache

  const blob = await canvas.convertToBlob(format === "png" ? { type: "image/png" } : { type: "image/jpeg", quality: 0.92 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await ComposerService.SaveRender(projectId, format, bytesToBase64(bytes));
  return { format, bytes: bytes.length, width, height };
}

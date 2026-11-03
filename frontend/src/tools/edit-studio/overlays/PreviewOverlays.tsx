/** Transform, mask and safe-zone overlays on the preview (§14.8). Wave 0 stub (owned by WP-ES10); the props are frozen. */
export interface PreviewOverlaysProps {
  /** The preview canvas (its on-screen box is where overlays draw). */
  canvas: HTMLCanvasElement | null;
  /** Preview size in canvas pixels. */
  width: number;
  height: number;
}

export function PreviewOverlays(props: PreviewOverlaysProps) {
  void props;
  return null;
}

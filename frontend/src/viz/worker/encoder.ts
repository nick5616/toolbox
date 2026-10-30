/** Encoder choice (SPEC.md §7.3): H.264 High (hardware, then software), else JPEG. */

export type EncoderChoice = { kind: "h264"; label: "h264-hw" | "h264-sw"; config: VideoEncoderConfig } | { kind: "jpeg"; label: "jpeg" };

/** Bitrate in bit/s (SPEC.md §7.3): by pixel count at 30 fps, ×1.5 at 60, ×1.6 for overlay stacks. */
export function bitrateFor(w: number, h: number, fps: number, overlay: boolean): number {
  const px = w * h;
  const base = px <= 1280 * 720 ? 8e6 : px <= 1920 * 1080 ? 14e6 : px <= 2560 * 1440 ? 24e6 : 45e6;
  return Math.round(base * (fps > 30 ? 1.5 : 1) * (overlay ? 1.6 : 1));
}

/** H.264 High level: 4.0 up to 1920×1088, 5.1 above. */
export function codecFor(w: number, h: number): string {
  return w * h <= 1920 * 1088 ? "avc1.640028" : "avc1.640033";
}

export async function chooseEncoder(width: number, canvasHeight: number, fps: number, overlay: boolean, forceJpeg = false): Promise<EncoderChoice> {
  if (forceJpeg || typeof VideoEncoder === "undefined") return { kind: "jpeg", label: "jpeg" };
  const base: VideoEncoderConfig = {
    codec: codecFor(width, canvasHeight),
    width,
    height: canvasHeight,
    bitrate: bitrateFor(width, overlay ? canvasHeight / 2 : canvasHeight, fps, overlay),
    framerate: fps,
    latencyMode: "quality",
    bitrateMode: "variable",
    avc: { format: "annexb" },
  };
  for (const [hw, label] of [
    ["prefer-hardware", "h264-hw"],
    ["prefer-software", "h264-sw"],
  ] as const) {
    const config: VideoEncoderConfig = { ...base, hardwareAcceleration: hw };
    try {
      const r = await VideoEncoder.isConfigSupported(config);
      if (r.supported) return { kind: "h264", label, config };
    } catch {
      // try the next
    }
  }
  return { kind: "jpeg", label: "jpeg" };
}

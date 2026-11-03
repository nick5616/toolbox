/**
 * How decoded frames reach WebGL (Phase 9 SPEC §16.1, §22.8). Two paths:
 *
 *  - "direct": the provider keeps the VideoFrame and the engine calls
 *    texImage2D(VideoFrame);
 *  - "bitmap": the provider converts with createImageBitmap(frame), closes the
 *    frame at once and keeps the ImageBitmap.
 *
 * The mode is module state shared by the provider and the engine of one JS
 * context. `initUploadMode` probes direct upload once (a tiny VideoFrame into
 * a throwaway texture); any failure switches to "bitmap" for good. Edit Lab
 * measures both and may force one with `setUploadMode`.
 */
import type { FrameImage } from "./types";

export type UploadMode = "direct" | "bitmap";

/** The default until the lab's decode bench says otherwise (SPEC §16.1 decision rule). */
export const DEFAULT_UPLOAD_MODE: UploadMode = "direct";

let mode: UploadMode = DEFAULT_UPLOAD_MODE;
let probed = false;
let reason = "";

export function getUploadMode(): UploadMode {
  return mode;
}

/** Forces a mode (Edit Lab, tests). Marks the probe as done so it won't override the choice. */
export function setUploadMode(m: UploadMode, why = "forced"): void {
  mode = m;
  probed = true;
  reason = why;
}

/** Why the current mode was chosen, for Edit Lab's report. */
export function uploadReason(): string {
  return reason;
}

/** Resets module state (tests). */
export function resetUploadMode(): void {
  mode = DEFAULT_UPLOAD_MODE;
  probed = false;
  reason = "";
}

/** True when texImage2D accepts a VideoFrame on this context. */
export function probeDirectUpload(gl: WebGL2RenderingContext): boolean {
  if (typeof VideoFrame === "undefined") return false;
  let frame: VideoFrame | null = null;
  const tex = gl.createTexture();
  try {
    while (gl.getError() !== gl.NO_ERROR) {
      // drain stale errors
    }
    frame = new VideoFrame(new Uint8Array(16), { format: "RGBA", codedWidth: 2, codedHeight: 2, timestamp: 0 });
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    return gl.getError() === gl.NO_ERROR;
  } catch {
    return false;
  } finally {
    frame?.close();
    gl.deleteTexture(tex);
  }
}

/** Runs the one-time feature check; call once per context. Returns the mode in effect. */
export function initUploadMode(gl: WebGL2RenderingContext): UploadMode {
  if (probed) return mode;
  probed = true;
  if (mode === "direct" && !probeDirectUpload(gl)) {
    mode = "bitmap";
    reason = "direct VideoFrame upload failed the probe";
  } else reason = mode === "direct" ? "direct VideoFrame upload passed the probe" : "default";
  return mode;
}

/** Called when a real direct upload failed: fall back permanently. */
export function fallBackToBitmap(why: string): void {
  mode = "bitmap";
  probed = true;
  reason = why;
}

export function isVideoFrame(img: FrameImage): img is VideoFrame {
  return typeof VideoFrame !== "undefined" && img instanceof VideoFrame;
}

/** The pixel size of an image (a VideoFrame's display size). */
export function imageSize(img: FrameImage): { w: number; h: number } {
  if (isVideoFrame(img)) return { w: img.displayWidth, h: img.displayHeight };
  return { w: img.width, h: img.height };
}

/** True once a VideoFrame was closed (it can't be uploaded any more). */
export function isClosed(img: FrameImage): boolean {
  return isVideoFrame(img) && img.format === null;
}

/**
 * Uploads `image` into `tex` (RGBA8; sRGB-decoded when `srgb`, linear for mattes).
 * Rows are not flipped: row 0 is the image's top. Throws when the browser
 * refuses the source.
 */
export function uploadFrameImage(gl: WebGL2RenderingContext, tex: WebGLTexture, image: FrameImage, srgb: boolean): void {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

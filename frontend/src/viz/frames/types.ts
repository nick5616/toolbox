/**
 * Frame source contracts (Phase 9 SPEC §8.1, §8.2). CONTRACT (Wave 0):
 * frozen. WP-ES3 implements them in this folder.
 */

/** <stream>.idx.json (Go StreamIndex). */
export interface StreamIndex {
  version: 1;
  /** "avc1.PPCCLL" for VideoDecoder.configure. */
  codec: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  /** frames + 1 entries; frame n is bytes [offsets[n], offsets[n+1]). */
  offsets: number[];
  /** IDR frame numbers (each carries SPS/PPS). */
  keys: number[];
  bytes: number;
}

/** A stream's /media URLs. */
export interface StreamRef {
  url: string;
  indexUrl: string;
}

/** What may be uploaded as a texture (the decode spike picks, §16.1). */
export type FrameImage = VideoFrame | ImageBitmap;

/** A frame of a stream; `stream` is an EditFiles.streams key. */
export interface FrameKey {
  stream: string;
  frame: number;
}

export interface FrameProvider {
  /** Decodes what `keys` need. exact=false (preview) may resolve before every frame is ready. */
  prepare(keys: FrameKey[], exact: boolean, signal?: AbortSignal): Promise<void>;
  /** The frame, or (inexact) the nearest earlier decoded frame of that stream, or null. */
  frame(key: FrameKey): FrameImage | null;
  /** Edit images by EditFiles.images key. */
  image(key: string): ImageBitmap | null;
  /**
   * Frames the next ~0.5 s will need, in play order (the host collects them
   * with EditEngine.needs), so the provider can decode ahead and drop the rest.
   */
  hint(ahead: FrameKey[], playing: boolean): void;
  dispose(): void;
}

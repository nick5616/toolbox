/**
 * Pure planning over a stream index (Phase 9 SPEC §8.2): GOP lookup, where a
 * decode run starts, and keyframe-aligned Range request groups. No I/O.
 */
import type { StreamIndex } from "./types";

/** Largest Range response the /media route answers (SPEC §8.2). */
export const MAX_RANGE_BYTES = 4 * 1024 * 1024;
/** Continue decoding forward when the target is at most this many GOPs ahead of the last fed frame. */
export const CONTINUE_GOPS = 2;

/** Validates a parsed <stream>.idx.json; returns the index or throws with a readable reason. */
export function parseStreamIndex(raw: unknown): StreamIndex {
  const o = raw as Partial<StreamIndex> | null;
  if (!o || typeof o !== "object") throw new Error("The frame index isn't an object");
  if (o.version !== 1) throw new Error(`Unsupported frame index version ${String(o.version)}`);
  if (typeof o.codec !== "string" || !o.codec.startsWith("avc1.")) throw new Error("The frame index has no H.264 codec");
  const { width, height, fps, frames, offsets, keys } = o;
  if (typeof width !== "number" || typeof height !== "number" || typeof fps !== "number" || typeof frames !== "number" || width <= 0 || height <= 0 || fps <= 0 || frames <= 0) {
    throw new Error("The frame index has bad sizes");
  }
  if (!Array.isArray(offsets) || offsets.length !== frames + 1) throw new Error("The frame index offsets don't match its frame count");
  for (let i = 1; i < offsets.length; i++) if ((offsets[i] as number) < (offsets[i - 1] as number)) throw new Error("The frame index offsets go backwards");
  if (!Array.isArray(keys) || keys.length === 0 || keys[0] !== 0) throw new Error("The frame index must start with a key frame");
  for (let i = 1; i < keys.length; i++) if ((keys[i] as number) <= (keys[i - 1] as number) || (keys[i] as number) >= frames) throw new Error("The frame index key list is invalid");
  return o as StreamIndex;
}

/** The last key frame at or before n (n clamped into the stream). */
export function keyAtOrBefore(keys: readonly number[], n: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((keys[mid] as number) <= n) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return keys[ans] ?? 0;
}

/** Position in `keys` of the GOP containing frame n. */
export function gopNumber(keys: readonly number[], n: number): number {
  return keys.indexOf(keyAtOrBefore(keys, n));
}

/** First and last frame of the GOP containing n. */
export function gopFrames(idx: Pick<StreamIndex, "keys" | "frames">, n: number): { first: number; last: number } {
  const g = gopNumber(idx.keys, n);
  const first = idx.keys[g] ?? 0;
  const next = idx.keys[g + 1];
  return { first, last: (next ?? idx.frames) - 1 };
}

/** Clamps a frame number into [0, frames − 1] (the clip holds its last frame). */
export function clampFrame(idx: Pick<StreamIndex, "frames">, n: number): number {
  return Math.max(0, Math.min(idx.frames - 1, n));
}

/** Byte range [start, end) of frame n's access unit. */
export function frameBytes(idx: Pick<StreamIndex, "offsets">, n: number): [number, number] {
  return [idx.offsets[n] as number, idx.offsets[n + 1] as number];
}

export interface DecodeStart {
  /** The first frame to feed. */
  start: number;
  /** Reset the decoder first (start is a key frame). */
  reset: boolean;
}

/**
 * Where a decode run for `target` starts. It continues from the decoder's last
 * fed frame when the target is ahead of it by at most CONTINUE_GOPS GOPs (the
 * decoder state stays valid); otherwise it resets to the key frame at or
 * before the target.
 */
export function chooseStart(keys: readonly number[], target: number, lastFed: number): DecodeStart {
  const key = keyAtOrBefore(keys, target);
  if (lastFed >= 0 && target > lastFed) {
    const gaps = gopNumber(keys, target) - gopNumber(keys, lastFed);
    if (gaps <= CONTINUE_GOPS) return { start: lastFed + 1, reset: false };
  }
  return { start: key, reset: true };
}

export interface FetchGroup {
  /** Byte range [start, end), at most maxBytes. */
  start: number;
  end: number;
  /** Frames whose access units begin inside the range. */
  firstFrame: number;
  lastFrame: number;
}

/** The frame whose access unit contains byte `pos`. */
export function frameAtByte(idx: Pick<StreamIndex, "offsets" | "frames">, pos: number): number {
  let lo = 0;
  let hi = idx.frames - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((idx.offsets[mid] as number) <= pos) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * Range requests covering frames [from, to]: whole GOPs grouped up to maxBytes
 * per request. A GOP larger than maxBytes is split by bytes.
 */
export function planFetch(idx: Pick<StreamIndex, "keys" | "frames" | "offsets">, from: number, to: number, maxBytes = MAX_RANGE_BYTES): FetchGroup[] {
  const a = gopFrames(idx, clampFrame(idx, from)).first;
  const b = gopFrames(idx, clampFrame(idx, to)).last;
  const groups: FetchGroup[] = [];
  let f = a;
  while (f <= b) {
    const g = gopFrames(idx, f);
    const gStart = idx.offsets[g.first] as number;
    const gEnd = idx.offsets[g.last + 1] as number;
    const last = groups[groups.length - 1];
    if (last && last.lastFrame === g.first - 1 && last.end === gStart && gEnd - last.start <= maxBytes) {
      last.end = gEnd;
      last.lastFrame = g.last;
    } else if (gEnd - gStart <= maxBytes) {
      groups.push({ start: gStart, end: gEnd, firstFrame: g.first, lastFrame: g.last });
    } else {
      for (let s = gStart; s < gEnd; s += maxBytes) {
        const e = Math.min(gEnd, s + maxBytes);
        groups.push({ start: s, end: e, firstFrame: frameAtByte(idx, s), lastFrame: frameAtByte(idx, e - 1) });
      }
    }
    f = g.last + 1;
  }
  return groups;
}

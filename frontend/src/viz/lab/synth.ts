/**
 * Synthetic edit media for Edit Lab and the decode bench (Phase 9 SPEC §16.1,
 * §17.3): Annex-B H.264 streams with their frame index, made in the webview
 * with WebCodecs (so the lab runs without FFmpeg or Go), a PNG photo, and an
 * in-memory `fetch` that serves them with Range support like /media does.
 *
 * No GL, no Wails: it also runs in a worker. Lab code only; pixel content is
 * deterministic per (label, frame).
 */
import type { StreamIndex } from "../frames/types";
import { codecFor } from "../worker/encoder";

export interface SynthStream {
  bytes: Uint8Array;
  index: StreamIndex;
}

export interface SynthOptions {
  width: number;
  height: number;
  fps: number;
  frames: number;
  gop: number;
  /** Picks the colour scheme. */
  hue: number;
  /** "color" burns the frame number over a gradient; "matte" draws a moving white disc on black. */
  kind?: "color" | "matte";
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function drawFrame(ctx: OffscreenCanvasRenderingContext2D, o: SynthOptions, i: number): void {
  const { width: w, height: h } = o;
  if (o.kind === "matte") {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    const t = i / o.fps;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(w * (0.5 + 0.25 * Math.sin(t * 1.3)), h * (0.5 + 0.2 * Math.cos(t * 0.9)), Math.min(w, h) * 0.22, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${(o.hue + i * 0.6) % 360} 70% 45%)`);
  g.addColorStop(1, `hsl(${(o.hue + 120 + i * 0.6) % 360} 70% 25%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  const s = Math.min(w, h) * 0.18;
  ctx.fillRect(((i * 7) % (w - s)) + 0, h * 0.7, s, s);
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${Math.round(Math.min(w, h) * 0.22)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(String(i), w / 2, h * 0.4);
}

/** Encodes frames with WebCodecs (Annex-B, no B-frames, a key frame every `gop`). */
export async function encodeSyntheticStream(o: SynthOptions): Promise<SynthStream> {
  if (typeof VideoEncoder === "undefined") throw new Error("VideoEncoder isn't available");
  const canvas = new OffscreenCanvas(o.width, o.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const codec = codecFor(o.width, o.height);
  const chunks: Array<{ b: Uint8Array; key: boolean }> = [];
  let err: Error | null = null;
  const enc = new VideoEncoder({
    output: (chunk) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      chunks.push({ b, key: chunk.type === "key" });
    },
    error: (e) => {
      err = e instanceof Error ? e : new Error(String(e));
    },
  });
  const base: VideoEncoderConfig = { codec, width: o.width, height: o.height, bitrate: Math.round(o.width * o.height * o.fps * 0.15), framerate: o.fps, avc: { format: "annexb" }, latencyMode: "quality" };
  let cfg = base;
  for (const hw of ["prefer-hardware", "prefer-software"] as const) {
    const c: VideoEncoderConfig = { ...base, hardwareAcceleration: hw };
    try {
      if ((await VideoEncoder.isConfigSupported(c)).supported) {
        cfg = c;
        break;
      }
    } catch {
      // try the next
    }
  }
  enc.configure(cfg);
  for (let i = 0; i < o.frames; i++) {
    if (err) throw err;
    drawFrame(ctx, o, i);
    const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / o.fps), duration: Math.round(1e6 / o.fps) });
    enc.encode(vf, { keyFrame: i % o.gop === 0 });
    vf.close();
    while (enc.encodeQueueSize > 4) await tick();
  }
  await enc.flush();
  enc.close();
  if (err) throw err;
  if (chunks.length !== o.frames) throw new Error(`The encoder produced ${chunks.length} of ${o.frames} frames`);
  const offsets: number[] = [0];
  const keys: number[] = [];
  chunks.forEach((c, i) => {
    offsets.push((offsets[i] as number) + c.b.length);
    if (c.key) keys.push(i);
  });
  const bytes = new Uint8Array(offsets[offsets.length - 1] as number);
  chunks.forEach((c, i) => bytes.set(c.b, offsets[i] as number));
  return { bytes, index: { version: 1, codec, width: o.width, height: o.height, fps: o.fps, frames: o.frames, offsets, keys, bytes: bytes.length } };
}

/** A PNG photo (a gradient with a frame and a label), as bytes. */
export async function syntheticPhoto(w: number, h: number, label: string): Promise<Uint8Array> {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#ff7a18");
  g.addColorStop(1, "#2b5876");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = Math.max(4, w / 60);
  ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - 2 * ctx.lineWidth, h - 2 * ctx.lineWidth);
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${Math.round(w * 0.12)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(label, w / 2, h / 2);
  const blob = await c.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

/** A `fetch` over in-memory files with Range support (what /media answers). */
export function memoryFetch(files: Map<string, Uint8Array>): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const data = files.get(url);
    if (!data) return Promise.resolve(new Response(null, { status: 404 }));
    const range = new Headers(init?.headers).get("Range");
    const m = range ? /bytes=(\d+)-(\d+)?/.exec(range) : null;
    if (!m) return Promise.resolve(new Response(data.slice() as BlobPart, { status: 200 }));
    const start = Number(m[1]);
    if (start >= data.length) return Promise.resolve(new Response(null, { status: 416 }));
    const end = Math.min(data.length, (m[2] ? Number(m[2]) : data.length - 1) + 1);
    return Promise.resolve(new Response(data.slice(start, end) as BlobPart, { status: 206, headers: { "Content-Range": `bytes ${start}-${end - 1}/${data.length}` } }));
  }) as typeof fetch;
}

/** FNV-1a over every byte of a pixel buffer. */
export function hashPixels(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ (bytes[i] ?? 0), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

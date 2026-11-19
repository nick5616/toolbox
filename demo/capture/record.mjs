// Page.startScreencast -> timestamped JPEG frames -> FFmpeg concat -> a 30 fps CFR H.264 mp4.
//
// The screencast only emits a frame when the page changes, so each frame's
// `metadata.timestamp` decides how long it is shown (the concat demuxer's
// per-frame `duration`). pause()/resume() split a recording into segments that
// are joined with a 0.4 s dissolve (xfade), which is how long jobs are skipped.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const FADE_S = 0.4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Quotes a path for an ffconcat `file` line. */
export function concatQuote(p) {
  return "'" + p.replace(/\\/g, "/").replace(/'/g, "'\\''") + "'";
}

/**
 * The ffconcat list for one segment. `frames` are {file, ts} (ts in seconds);
 * each frame lasts until the next one, the last until `endTs` (at least one
 * output frame). Returns {text, duration} (duration in seconds).
 */
export function concatList(frames, endTs, fps = FPS) {
  if (frames.length === 0) return { text: "", duration: 0 };
  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  const minD = 1 / fps;
  const lines = ["ffconcat version 1.0"];
  let total = 0;
  sorted.forEach((f, i) => {
    const next = i + 1 < sorted.length ? sorted[i + 1].ts : endTs;
    // Frames arriving faster than the output rate keep their real (short) durations; the fps filter picks among them.
    const last = i + 1 >= sorted.length;
    const d = Math.max(last ? minD : 0.001, next - f.ts);
    total += d;
    lines.push(`file ${concatQuote(f.file)}`, `duration ${d.toFixed(6)}`);
  });
  // The demuxer ignores the last duration unless the file is repeated.
  lines.push(`file ${concatQuote(sorted[sorted.length - 1].file)}`);
  return { text: lines.join("\n") + "\n", duration: total };
}

/** A fade no longer than a third of the shortest segment. */
export function clampFade(durations, fade = FADE_S) {
  const shortest = Math.min(...durations);
  return Math.max(0.04, Math.min(fade, shortest / 3));
}

/** xfade offsets for joining segments of these durations with `fade` seconds of overlap. */
export function xfadeOffsets(durations, fade = FADE_S) {
  const out = [];
  let acc = durations[0] ?? 0;
  for (let i = 1; i < durations.length; i++) {
    out.push(Number((acc - fade).toFixed(6)));
    acc += durations[i] - fade;
  }
  return out;
}

/** Total length after joining (overlaps removed). */
export function joinedDuration(durations, fade = FADE_S) {
  return durations.reduce((a, d) => a + d, 0) - fade * Math.max(0, durations.length - 1);
}

/** FFmpeg arguments for the final encode of one or more concat lists. */
export function buildFfmpegArgs({ lists, durations, out, fps = FPS, width = WIDTH, height = HEIGHT, fade = FADE_S }) {
  // The screencast JPEGs are full-range (yuvj420p); convert to limited-range BT.709 explicitly.
  const norm = `fps=${fps},scale=${width}:${height}:flags=lanczos+accurate_rnd+full_chroma_int:in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p,setpts=PTS-STARTPTS`;
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const l of lists) args.push("-f", "concat", "-safe", "0", "-i", l);
  if (lists.length === 1) {
    args.push("-vf", norm);
  } else {
    const f = clampFade(durations, fade);
    const offs = xfadeOffsets(durations, f);
    const parts = lists.map((_, i) => `[${i}:v]${norm}[v${i}]`);
    let acc = "v0";
    offs.forEach((o, i) => {
      const label = i === offs.length - 1 ? "vout" : `x${i + 1}`;
      parts.push(`[${acc}][v${i + 1}]xfade=transition=fade:duration=${f.toFixed(3)}:offset=${o.toFixed(3)}[${label}]`);
      acc = label;
    });
    args.push("-filter_complex", parts.join(";"), "-map", "[vout]");
  }
  args.push(
    "-an",
    "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-fps_mode", "cfr", "-r", String(fps),
    "-movflags", "+faststart",
    out,
  );
  return args;
}

/** FFmpeg from PATH, else a managed copy under the tools folder. */
export function findFfmpeg(toolsDir) {
  const tryRun = (p) => spawnSync(p, ["-version"], { stdio: "ignore", windowsHide: true }).status === 0;
  if (tryRun("ffmpeg")) return "ffmpeg";
  if (toolsDir) {
    const root = path.join(toolsDir, "bin", "ffmpeg");
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      let ents = [];
      try {
        ents = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (/^ffmpeg(\.exe)?$/i.test(e.name) && tryRun(p)) return p;
      }
    }
  }
  throw new Error("FFmpeg not found (put it on PATH, or install it from Toolbox's Settings)");
}

function runFfmpeg(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`))));
  });
}

export class Recorder {
  /**
   * @param cdp   the client from cdp.mjs
   * @param opts  {dir: temp dir for frames, ffmpeg: binary, quality: 92}
   */
  constructor(cdp, { dir, ffmpeg = "ffmpeg", quality = 92, fps = FPS, keepFrames = false } = {}) {
    this.cdp = cdp;
    this.dir = dir;
    this.ffmpeg = ffmpeg;
    this.quality = quality;
    this.fps = fps;
    this.keepFrames = keepFrames;
    this.segments = [];
    this.current = null;
    this.state = "idle"; // idle | recording | paused
    this.pausedMs = 0;
    this._pausedAt = 0;
    this._off = null;
    this._writes = [];
    this._frameNo = 0;
  }

  async start() {
    if (this.state !== "idle") throw new Error("recording already started");
    fs.mkdirSync(this.dir, { recursive: true });
    this.segments = [];
    this.pausedMs = 0;
    this._frameNo = 0;
    this._off = this.cdp.on("Page.screencastFrame", (p) => this._onFrame(p));
    await this._begin();
    this.state = "recording";
  }

  async _begin() {
    this.current = { frames: [], startedAt: Date.now() / 1000 };
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: this.quality, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });
    // A static page sends nothing: nudge a repaint so the segment has a first frame.
    for (let i = 0; i < 8 && this.current.frames.length === 0; i++) await sleep(100);
    if (this.current.frames.length === 0) {
      await this.cdp.eval("document.documentElement.style.outline='1px solid transparent';requestAnimationFrame(()=>{document.documentElement.style.outline=''})").catch(() => {});
      for (let i = 0; i < 20 && this.current.frames.length === 0; i++) await sleep(100);
    }
  }

  _onFrame(p) {
    // Ack at once: the browser stalls the screencast until every frame is acknowledged.
    this.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
    const seg = this.current;
    if (!seg || this.state === "paused") return;
    const ts = typeof p.metadata?.timestamp === "number" ? p.metadata.timestamp : Date.now() / 1000;
    const file = path.join(this.dir, `f${String(++this._frameNo).padStart(6, "0")}.jpg`);
    seg.frames.push({ file, ts });
    this._writes.push(fs.promises.writeFile(file, Buffer.from(p.data, "base64")));
  }

  async _end() {
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    const seg = this.current;
    seg.endTs = Math.max(Date.now() / 1000, (seg.frames.at(-1)?.ts ?? 0) + 1 / this.fps);
    this.current = null;
    if (seg.frames.length > 0) this.segments.push(seg);
  }

  /** Stops capturing while something slow runs; resume() joins the next part with a dissolve. */
  async pause() {
    if (this.state !== "recording") return;
    await this._end();
    this.state = "paused";
    this._pausedAt = Date.now();
  }

  async resume() {
    if (this.state !== "paused") return;
    this.pausedMs += Date.now() - this._pausedAt;
    await this._begin();
    this.state = "recording";
  }

  /** Finishes the recording and encodes `outFile`. Returns {file, duration, segments, compressedMs}. */
  async stop(outFile) {
    if (this.state === "idle") throw new Error("not recording");
    if (this.state === "recording") await this._end();
    this._off?.();
    this.state = "idle";
    await Promise.all(this._writes);
    this._writes = [];
    if (this.segments.length === 0) throw new Error("the screencast produced no frames");
    const lists = [];
    const durations = [];
    this.segments.forEach((seg, i) => {
      const { text, duration } = concatList(seg.frames, seg.endTs, this.fps);
      const f = path.join(this.dir, `seg${i}.txt`);
      fs.writeFileSync(f, text);
      lists.push(f);
      durations.push(duration);
    });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    await runFfmpeg(this.ffmpeg, buildFfmpegArgs({ lists, durations, out: outFile, fps: this.fps }));
    const result = { file: outFile, duration: joinedDuration(durations, clampFade(durations)), segments: this.segments.length, compressedMs: this.pausedMs };
    if (!this.keepFrames) fs.rmSync(this.dir, { recursive: true, force: true });
    this.segments = [];
    return result;
  }

  /** Drops a recording in progress without encoding (error paths). */
  async abort() {
    if (this.state === "idle") return;
    try {
      if (this.state === "recording") await this.cdp.send("Page.stopScreencast").catch(() => {});
    } finally {
      this._off?.();
      this.state = "idle";
      await Promise.allSettled(this._writes);
      this._writes = [];
      if (!this.keepFrames) fs.rmSync(this.dir, { recursive: true, force: true });
      this.segments = [];
      this.current = null;
    }
  }
}

/** A still PNG of the page. */
export async function takeStill(cdp, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await cdp.screenshot({ format: "png" }));
  return file;
}

/**
 * VizLab motion mode (Phase 21 SPEC §C4): `TOOLBOX_VIZLAB_MODE=motion`.
 * Renders every preset for 30 s at 60 fps starting at 30% of the song, at
 * Calm 0.5 / Balanced 1 / Wild 1.5, reads each frame back, and feeds the
 * metric. Writes motion.json (MotionReport) and motion-sheet-<preset>.png
 * (24 frames, one per 1.25 s, Balanced) through the VizLab sink.
 *
 * Words are left out of the measurement (`text=1` keeps them). Query extras: `commit=<hash>` (recorded in the report), `secs=<n>` (shorter
 * runs for smoke tests), `only=<preset id>`.
 */
import type { Analysis } from "../analysis";
import { Engine } from "../engine";
import { activeAt, timelineFor } from "../director";
import { PRESETS, showFromPreset, type Preset } from "../presets";
import type { Show } from "../types";
import { MOTION_H, MOTION_W, measureMotion, toMotionFrame } from "./motion";
import type { MotionEntry, MotionFrame, MotionReport } from "./motionTypes";

export const MOTION_FPS = 60;
export const MOTION_SECONDS = 30;
export const INTENSITIES: ReadonlyArray<readonly [string, number]> = [
  ["calm", 0.5],
  ["balanced", 1],
  ["wild", 1.5],
];
const W = 640;
const H = 360;
const SHEET_COLS = 6;
const SHEET_ROWS = 4;
const THUMB_W = 160;
const THUMB_H = 90;

/**
 * Whether the frame at `tMs` sits inside a director transition: a crossfade
 * (or any non-cut) window in progress, or a scene boundary (hard cuts)
 * between the previous frame and this one.
 */
export function inTransitionAt(entries: Show["timeline"]["entries"], prevMs: number, tMs: number): boolean {
  if (activeAt(entries, tMs)?.previous || activeAt(entries, prevMs)?.previous) return true;
  const step = tMs - prevMs;
  return entries.some((e, i) => i > 0 && e.startMs > prevMs - step && e.startMs <= tMs);
}

export async function runMotion(opts: {
  analysis: Analysis;
  source: string;
  canvas: HTMLCanvasElement;
  q: URLSearchParams;
  say: (s: string) => void;
  send: (name: string, bytes: Uint8Array) => void;
  sendJSON: (name: string, v: unknown) => void;
  stopped: () => boolean;
}): Promise<void> {
  const { analysis: a, canvas, q, say } = opts;
  const only = q.get("only");
  const secs = Math.max(2, Number(q.get("secs")) || MOTION_SECONDS);
  const presets: Preset[] = PRESETS.filter((p) => !only || p.id === only);
  const frameCount = Math.round(secs * MOTION_FPS);
  const startMs = Math.max(0, Math.min(a.durationMs * 0.3, a.durationMs - secs * 1000));
  const report: MotionReport = { version: 1, commit: q.get("commit") ?? "unknown", entries: [] };
  canvas.style.width = `${W / 2}px`;
  canvas.style.height = `${H / 2}px`;
  const sheetEvery = Math.round(1.25 * MOTION_FPS);

  for (const p of presets) {
    let sheet: HTMLCanvasElement | null = null;
    for (const [name, intensity] of INTENSITIES) {
      if (opts.stopped()) return;
      const show = showFromPreset(p);
      show.reactivity = intensity;
      // the words are the host tool's (Lyric Video, Subtitles draw their own) and a new line is a content change, not a jump of the visuals: measured without them unless `text=1`
      if (q.get("text") !== "1") show.text = null;
      const engine = new Engine(canvas, { width: W, height: H, mode: "opaque", quality: "full", seed: 1, fps: MOTION_FPS, inWorker: false });
      engine.setAnalysis(a);
      engine.setShow(show);
      const entries = timelineFor(a, show);
      const frames: MotionFrame[] = [];
      let shot = 0;
      if (name === "balanced") {
        sheet = document.createElement("canvas");
        sheet.width = THUMB_W * SHEET_COLS;
        sheet.height = THUMB_H * SHEET_ROWS;
      }
      const sctx = sheet && name === "balanced" ? sheet.getContext("2d") : null;
      for (let i = 0; i < frameCount; i++) {
        const t = startMs + (i * 1000) / MOTION_FPS;
        engine.render(t);
        const px = engine.readPixels();
        const f = toMotionFrame(px, W, H, i > 0 && inTransitionAt(entries, startMs + ((i - 1) * 1000) / MOTION_FPS, t));
        frames.push(f);
        if (sctx && i % sheetEvery === 0 && shot < SHEET_COLS * SHEET_ROWS) {
          sctx.drawImage(canvas, (shot % SHEET_COLS) * THUMB_W, Math.floor(shot / SHEET_COLS) * THUMB_H, THUMB_W, THUMB_H);
          shot++;
        }
        if (i % 120 === 119) {
          await new Promise((r) => setTimeout(r, 0));
          if (opts.stopped()) {
            engine.dispose();
            return;
          }
        }
      }
      engine.dispose();
      const stats = measureMotion(frames, MOTION_FPS);
      const entry: MotionEntry = { preset: p.id, source: opts.source, intensity, frames: frames.length, fps: MOTION_FPS, ...stats };
      report.entries.push(entry);
      say(`${p.id} ${name}: flash ${stats.flashMaxPerSec} tele ${stats.teleports} p95 ${stats.p95Delta.toFixed(3)} hue ${stats.hueChurn.toFixed(1)}`);
      if (sctx && sheet) {
        const blob = await new Promise<Blob | null>((r) => (sheet as HTMLCanvasElement).toBlob(r, "image/png"));
        if (blob) opts.send(`motion-sheet-${p.id}.png`, new Uint8Array(await blob.arrayBuffer()));
      }
    }
    opts.sendJSON("motion.json", report); // partial results survive a crash
  }
  opts.sendJSON("motion.json", report);
  opts.sendJSON("done.json", { motion: true, presets: presets.length, at: new Date().toISOString() });
  say("motion done");
}

export { MOTION_H, MOTION_W };

/**
 * Text clips (Phase 9 Part B, WP-FX4): registers the "text" generator. The
 * clip's text becomes a synthetic TextDoc (song-ms word times implementing
 * the reveal), and the captions' text layer draws it into the clip's target.
 */
import type { Analysis, TextDoc, TextLine, TextWord } from "../analysis";
import { createTextLayer, type TextLayer } from "../text";
import { registerGenerator, type GeneratorFrame, type GeneratorInstance } from "./generated";
import type { TextClip } from "./types";

/**
 * The words of a text clip with song-ms times.
 * - Lines split on "\n"; a line ends with the clip.
 * - "all": every word of a line appears at its line start (a single line: the clip start; several lines show one after another, evenly spread over the clip, as the layer shows the latest started line).
 * - "words": word i (counting across lines) appears at start + i * wordMs.
 * - "beats": word i lands on the i-th picked marker (every Nth) inside the clip; words left over land at the clip end.
 */
export function textDocForClip(clip: TextClip, clipStartSongMs: number, clipEndSongMs: number, markersSongMs: readonly number[]): TextDoc {
  const start = clipStartSongMs;
  const end = Math.max(clipEndSongMs, start);
  const rawLines = clip.text.split("\n").map((l) => l.split(/\s+/).filter((w) => w.length > 0));
  const lineWords = rawLines.filter((w) => w.length > 0);
  const every = Math.max(1, Math.round(clip.every));
  const picks = markersSongMs.filter((m) => m >= start && m < end).sort((a, b) => a - b).filter((_, i) => i % every === 0);

  const lines: TextLine[] = [];
  let n = 0;
  lineWords.forEach((words, li) => {
    const times = words.map((_, wi) => {
      const i = n + wi;
      if (clip.reveal === "words") return Math.min(end, start + i * clip.wordMs);
      if (clip.reveal === "beats") return picks[i] ?? end;
      return start + Math.floor(((end - start) * li) / lineWords.length);
    });
    n += words.length;
    const lineStart = times[0] ?? start;
    const out: TextWord[] = words.map((text, wi) => {
      const s = times[wi] as number;
      const next = times[wi + 1];
      return { startMs: s, endMs: Math.max(s, next !== undefined && next > s ? next : end), text };
    });
    lines.push({ startMs: lineStart, endMs: end, text: words.join(" "), words: out });
  });
  return { version: 1, source: "text-clip", language: "", matched: 0, lines, mood: [] };
}

function create(ctx: Parameters<Parameters<typeof registerGenerator>[1]>[0]): GeneratorInstance {
  const gl = ctx.gl;
  let layer: TextLayer | null = createTextLayer({ gl, fullscreen: ctx.fullscreen, w: ctx.w, h: ctx.h, inWorker: ctx.inWorker });
  let cacheKey = "";
  let cacheAnalysis: Analysis | null = null;
  let baseAnalysis: Analysis | null = null;

  return {
    render(_target, f: GeneratorFrame) {
      const t = f.clip.text;
      if (!layer || !t) return;
      const clipStartSong = f.songMs - f.clipMs;
      const clipEndSong = clipStartSong + (f.clip.endMs - f.clip.startMs);
      const offset = clipStartSong - f.clip.startMs; // timeline ms -> song ms
      const marks = t.reveal === "beats" ? f.markers.filter((m) => m.lane === t.lane).map((m) => m.ms + offset) : [];
      const key = `${JSON.stringify(t)}|${clipStartSong}|${clipEndSong}|${marks.join(",")}`;
      if (key !== cacheKey || baseAnalysis !== f.input.analysis || !cacheAnalysis) {
        cacheAnalysis = f.input.analysis.withText(textDocForClip(t, clipStartSong, clipEndSong, marks));
        baseAnalysis = f.input.analysis;
        cacheKey = key;
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      layer.render({ ...f.input, analysis: cacheAnalysis }, t.style);
      gl.disable(gl.BLEND);
    },
    resize(w, h) {
      layer?.resize(w, h);
    },
    dispose() {
      layer?.dispose();
      layer = null;
      cacheAnalysis = null;
      baseAnalysis = null;
    },
  };
}

registerGenerator("text", (ctx) => create(ctx));

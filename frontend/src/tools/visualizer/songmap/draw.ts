/**
 * Canvas drawing for the Song Map lanes. Each function paints one lane for the
 * visible window only, so long songs stay cheap: nothing here runs per
 * playhead tick, only on resize, zoom, scroll and data changes.
 */
import type { Analysis } from "@/viz/analysis";
import { MOOD_PALETTE, PALETTE_BY_ID } from "@/viz/palette";
import type { Emotion, TimelineEntry } from "@/viz/types";
import { groupHue, MOTIF_GLYPH, rulerLabel, rulerStepSec, sectionBlocks, type SongMapLaneId, type View } from "./model";

export interface Theme {
  fg: string;
  fgMuted: string;
  fgSubtle: string;
  line: string;
  accent: string;
  inset: string;
}

const FALLBACK: Theme = { fg: "#ededef", fgMuted: "#a1a2aa", fgSubtle: "#6b6d76", line: "rgba(255,255,255,0.12)", accent: "#ff8c42", inset: "#0d0e10" };

export function readTheme(el: Element | null): Theme {
  if (!el || typeof getComputedStyle !== "function") return FALLBACK;
  const cs = getComputedStyle(el);
  const get = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return {
    fg: get("--fg", FALLBACK.fg),
    fgMuted: get("--fg-muted", FALLBACK.fgMuted),
    fgSubtle: get("--fg-subtle", FALLBACK.fgSubtle),
    line: get("--line-strong", FALLBACK.line),
    accent: get("--accent", FALLBACK.accent),
    inset: get("--bg-inset", FALLBACK.inset),
  };
}

export function emotionColor(e: Emotion): string {
  return PALETTE_BY_ID.get(MOOD_PALETTE[e])?.accent ?? "#888888";
}

const FONT = '11px "Geist Variable", system-ui, sans-serif';

interface Ctx {
  c: CanvasRenderingContext2D;
  a: Analysis;
  view: View;
  /** Pixels per second. */
  pps: number;
  w: number;
  h: number;
  theme: Theme;
}

const xOf = (k: Ctx, ms: number) => ((ms - k.view.startMs) / 1000) * k.pps;

function clip(k: Ctx, x0: number, x1: number): [number, number] | null {
  const a = Math.max(0, x0);
  const b = Math.min(k.w, x1);
  return b > a ? [a, b] : null;
}

function text(k: Ctx, s: string, x: number, maxW: number, y: number, color: string, bold = false) {
  const c = k.c;
  c.font = bold ? `600 ${FONT}` : FONT;
  c.fillStyle = color;
  c.textBaseline = "middle";
  let out = s;
  if (typeof c.measureText === "function") {
    while (out.length > 1 && c.measureText(out).width > maxW) out = out.slice(0, -1);
    if (out.length < s.length && out.length > 1) out = `${out.slice(0, -1)}…`;
    if (out.length <= 1 && c.measureText(out).width > maxW) return;
  }
  c.fillText(out, x, y);
}

function drawSections(k: Ctx, timeline?: readonly TimelineEntry[] | null) {
  const { c, h } = k;
  for (const b of sectionBlocks(k.a, timeline)) {
    const r = clip(k, xOf(k, b.startMs), xOf(k, b.endMs));
    if (!r) continue;
    c.fillStyle = `hsl(${groupHue(b.group)} 55% 45%)`;
    c.fillRect(r[0] + 0.5, 2, Math.max(1, r[1] - r[0] - 1), h - 4);
    text(k, b.label, r[0] + 5, r[1] - r[0] - 8, h / 2, "#fff", true);
  }
}

function drawBeats(k: Ctx) {
  const { c, h, a, view, pps } = k;
  const t0 = view.startMs - 50;
  const t1 = view.endMs + 50;
  const beatPx = (60_000 / Math.max(1, a.audio.tempo) / 1000) * pps;
  if (beatPx >= 4) {
    c.fillStyle = k.theme.fgSubtle;
    for (const t of a.audio.beats) {
      if (t < t0) continue;
      if (t > t1) break;
      c.fillRect(Math.round(xOf(k, t)), h * 0.55, 1, h * 0.45);
    }
  }
  c.fillStyle = k.theme.fgMuted;
  let last = -10;
  for (const t of a.audio.downbeats) {
    if (t < t0) continue;
    if (t > t1) break;
    const x = Math.round(xOf(k, t));
    if (x - last < 3) continue;
    last = x;
    c.fillRect(x, 2, 1, h - 4);
  }
}

/** Per-pixel-column peak of a 0..1 channel over the window. */
function peaks(k: Ctx, id: string): Float32Array {
  const ch = k.a.channel(id);
  const out = new Float32Array(Math.max(1, Math.ceil(k.w)));
  if (!ch) return out;
  for (let px = 0; px < out.length; px++) {
    const f0 = Math.floor(k.a.frameAt(k.view.startMs + ((px / k.pps) * 1000)));
    const f1 = Math.max(f0, Math.floor(k.a.frameAt(k.view.startMs + (((px + 1) / k.pps) * 1000))));
    let m = 0;
    for (let f = f0; f <= f1; f++) {
      const v = ch[f] ?? 0;
      if (v > m) m = v;
    }
    out[px] = m;
  }
  return out;
}

function areaPath(k: Ctx, p: Float32Array, color: string) {
  const { c, h } = k;
  const end = Math.min(p.length, Math.ceil(xOf(k, k.a.durationMs)));
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(0, h);
  for (let px = 0; px < end; px++) c.lineTo(px, h - 2 - (p[px] ?? 0) * (h - 4));
  c.lineTo(Math.max(0, end), h);
  c.closePath();
  c.fill();
}

function drawStem(k: Ctx, stem: "bass" | "other") {
  areaPath(k, peaks(k, `${stem}.level`), stem === "bass" ? k.theme.accent : k.theme.fgMuted);
}

function drawDrums(k: Ctx) {
  const { c, h, a, view } = k;
  const rows: Array<[string, number]> = [
    ["hats", h * 0.2],
    ["snare", h * 0.5],
    ["kick", h * 0.8],
  ];
  for (const [id, y] of rows) {
    const ev = a.eventsBetween(id, view.startMs - 100, view.endMs + 100);
    c.fillStyle = id === "kick" ? k.theme.accent : id === "snare" ? k.theme.fg : k.theme.fgMuted;
    let last = -10;
    const r = id === "hats" ? 1.2 : 2;
    for (const [t, s] of ev) {
      const x = xOf(k, t);
      if (x - last < 1.5) continue;
      last = x;
      c.globalAlpha = 0.35 + 0.65 * (s / 255);
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
  }
}

function drawVocals(k: Ctx) {
  const { c, h, a } = k;
  areaPath(k, peaks(k, "vocals.level"), k.theme.fgSubtle);
  const pitch = a.channel("vocals.pitch");
  const voiced = a.channel("vocals.voiced");
  if (!pitch) return;
  c.strokeStyle = k.theme.accent;
  c.lineWidth = 1.5;
  c.beginPath();
  let pen = false;
  const end = Math.min(Math.ceil(k.w), Math.ceil(xOf(k, a.durationMs)));
  for (let px = 0; px < end; px++) {
    const ms = k.view.startMs + (px / k.pps) * 1000;
    const f = a.frameAt(ms);
    const on = !voiced || (voiced[Math.round(f)] ?? 0) > 0.5;
    if (!on) {
      pen = false;
      continue;
    }
    const y = h - 3 - (pitch[Math.round(f)] ?? 0) * (h - 6);
    if (pen) c.lineTo(px, y);
    else c.moveTo(px, y);
    pen = true;
  }
  c.stroke();
}

function drawChords(k: Ctx) {
  const { c, h, a, view } = k;
  for (const ch of a.audio.chords) {
    if (ch.endMs < view.startMs) continue;
    if (ch.startMs > view.endMs) break;
    const r = clip(k, xOf(k, ch.startMs), xOf(k, ch.endMs));
    if (!r) continue;
    const none = ch.name === "N" || ch.root < 0;
    c.fillStyle = none ? k.theme.inset : `hsl(${(ch.root * 30 + (ch.minor ? 200 : 0)) % 360} 45% ${ch.minor ? 30 : 38}%)`;
    c.fillRect(r[0] + 0.5, 2, Math.max(1, r[1] - r[0] - 1), h - 4);
    if (!none) text(k, ch.name, r[0] + 4, r[1] - r[0] - 6, h / 2, "#fff");
  }
}

function drawMood(k: Ctx) {
  const { c, h, a } = k;
  const keys = a.text?.mood ?? [];
  for (let i = 0; i < keys.length; i++) {
    const m = keys[i];
    if (!m) continue;
    const end = keys[i + 1]?.ms ?? a.durationMs;
    const r = clip(k, xOf(k, m.ms), xOf(k, end));
    if (!r) continue;
    c.fillStyle = emotionColor(m.emotion);
    c.globalAlpha = 0.3 + 0.7 * ((m.valence + 1) / 2);
    c.fillRect(r[0], 2, Math.max(1, r[1] - r[0]), h - 4);
  }
  c.globalAlpha = 1;
}

function drawLyrics(k: Ctx) {
  const { c, h, a, view } = k;
  for (const line of a.text?.lines ?? []) {
    if (line.endMs < view.startMs) continue;
    if (line.startMs > view.endMs) break;
    const r = clip(k, xOf(k, line.startMs), xOf(k, line.endMs));
    if (!r) continue;
    const width = r[1] - r[0];
    c.fillStyle = k.theme.inset;
    c.fillRect(r[0] + 0.5, 2, Math.max(1, width - 1), h - 4);
    c.strokeStyle = line.meaning ? emotionColor(line.meaning.emotion) : k.theme.line;
    c.lineWidth = 1;
    c.strokeRect(r[0] + 0.5, 2.5, Math.max(1, width - 1), h - 5);
    const motif = line.meaning?.motifs[0];
    let x = r[0] + 4;
    if (motif && width > 40) {
      c.font = FONT;
      c.fillStyle = k.theme.fg;
      c.textBaseline = "middle";
      c.fillText(MOTIF_GLYPH[motif] ?? "", x, h * 0.35);
      x += 14;
    }
    if (width > 90) {
      // Words with the emphasised ones in bold, as far as the block allows.
      let wx = x;
      const limit = r[1] - 4;
      for (const w of line.words) {
        c.font = w.emphasis ? `700 ${FONT}` : FONT;
        const tw = typeof c.measureText === "function" ? c.measureText(`${w.text} `).width : 30;
        if (wx + tw > limit) break;
        c.fillStyle = w.emphasis ? k.theme.fg : k.theme.fgMuted;
        c.fillText(`${w.text} `, wx, h * 0.62);
        wx += tw;
      }
    }
  }
}

function drawRuler(k: Ctx) {
  const { c, h } = k;
  const step = rulerStepSec(k.pps);
  c.fillStyle = k.theme.fgSubtle;
  c.font = '10px "Geist Mono Variable", ui-monospace, monospace';
  c.textBaseline = "middle";
  const first = Math.ceil(k.view.startMs / 1000 / step) * step;
  for (let s = first; s * 1000 <= k.view.endMs + 1; s += step) {
    const x = Math.round(xOf(k, s * 1000));
    c.fillRect(x, h - 5, 1, 5);
    c.fillText(rulerLabel(s * 1000), x + 3, h / 2 - 1);
  }
}

/** Paints one lane (or the time ruler) into a canvas context already scaled to CSS pixels. */
export function drawLane(
  c: CanvasRenderingContext2D,
  lane: SongMapLaneId | "ruler",
  a: Analysis,
  view: View,
  pxPerSec: number,
  w: number,
  h: number,
  theme: Theme,
  timeline?: readonly TimelineEntry[] | null,
): void {
  c.clearRect(0, 0, w, h);
  const k: Ctx = { c, a, view, pps: pxPerSec, w, h, theme };
  c.save();
  switch (lane) {
    case "ruler":
      drawRuler(k);
      break;
    case "sections":
      drawSections(k, timeline);
      break;
    case "beats":
      drawBeats(k);
      break;
    case "drums":
      drawDrums(k);
      break;
    case "bass":
      drawStem(k, "bass");
      break;
    case "other":
      drawStem(k, "other");
      break;
    case "vocals":
      drawVocals(k);
      break;
    case "chords":
      drawChords(k);
      break;
    case "mood":
      drawMood(k);
      break;
    case "lyrics":
      drawLyrics(k);
      break;
  }
  c.restore();
}

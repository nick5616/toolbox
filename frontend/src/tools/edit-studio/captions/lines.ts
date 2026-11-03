/**
 * Pure edits of a caption line list (§14.9). Every function takes and returns
 * the FULL TextLine[] in song ms (the thing stored in Captions.lines) and
 * addresses a line by its index in that array.
 */
import type { TextLine, TextWord } from "@/viz/analysis";
import { parseCaptionLines } from "@/viz/edit/schema";
import type { EditCaptions } from "@/lib/api";
import type { Analysis } from "@/viz/analysis";

/** Length of a line inserted into a gap. */
export const NEW_LINE_MS = 2000;
const MIN_LINE_MS = 200;

const tokens = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** The lines the captions show: the edited list when set, else the analysis's. */
export function effectiveLines(captions: Pick<EditCaptions, "lines"> | null, analysis: Analysis | null): TextLine[] {
  if (captions?.lines) {
    const p = parseCaptionLines(captions.lines);
    if (p.value) return p.value;
  }
  return (analysis?.text?.lines ?? []).map((l) => ({ startMs: l.startMs, endMs: l.endMs, text: l.text, words: l.words.map((w) => ({ ...w })) }));
}

/** The index range [from, to) of lines that overlap the song range. */
export function linesInRange(lines: TextLine[], startMs: number, endMs: number): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (l.endMs > startMs && l.startMs < endMs) out.push(i);
  });
  return out;
}

export interface SrtCue {
  startMs: number;
  endMs: number;
  text: string;
  words: Array<{ startMs: number; endMs: number; text: string }>;
}

/** Lines inside the song range, shifted to timeline ms and clamped to 0..D. */
export function srtCues(lines: TextLine[], startMs: number, endMs: number): SrtCue[] {
  const d = Math.max(0, endMs - startMs);
  const clamp = (v: number) => Math.min(d, Math.max(0, v));
  const out: SrtCue[] = [];
  for (const l of lines) {
    if (l.endMs <= startMs || l.startMs >= endMs) continue;
    const text = l.text.trim();
    if (!text) continue;
    out.push({ startMs: clamp(l.startMs - startMs), endMs: clamp(l.endMs - startMs), text, words: [] });
  }
  return out;
}

const replace = (lines: TextLine[], i: number, l: TextLine): TextLine[] => lines.map((x, k) => (k === i ? l : x));

function clampWords(words: TextWord[], start: number, end: number): TextWord[] {
  return words.map((w) => {
    const s = Math.min(end, Math.max(start, w.startMs));
    return { ...w, startMs: s, endMs: Math.min(end, Math.max(s, w.endMs)) };
  });
}

/** Spreads `texts` evenly over [start, end]. */
function spread(texts: string[], start: number, end: number): TextWord[] {
  const n = texts.length;
  if (!n) return [];
  const step = (end - start) / n;
  return texts.map((text, k) => ({ text, startMs: Math.round(start + k * step), endMs: Math.round(start + (k + 1) * step) }));
}

function joinWords(words: TextWord[]): string {
  return words.map((w) => w.text).join(" ");
}

/** Edits a line's text; words keep their times when the word count is unchanged, else spread evenly. */
export function setLineText(lines: TextLine[], i: number, text: string): TextLine[] {
  const l = lines[i];
  if (!l) return lines;
  const toks = tokens(text);
  const words = toks.length === l.words.length ? l.words.map((w, k) => ({ ...w, text: toks[k] as string })) : spread(toks, l.startMs, l.endMs);
  return replace(lines, i, { ...l, text, words });
}

/** Moves a line's start and/or end (song ms); the end never precedes the start; words are kept inside. */
export function setLineTime(lines: TextLine[], i: number, t: { startMs?: number; endMs?: number }): TextLine[] {
  const l = lines[i];
  if (!l) return lines;
  const startMs = Math.max(0, Math.round(t.startMs ?? l.startMs));
  const endMs = Math.max(startMs, Math.round(t.endMs ?? l.endMs));
  if (startMs === l.startMs && endMs === l.endMs) return lines;
  return replace(lines, i, { ...l, startMs, endMs, words: clampWords(l.words, startMs, endMs) });
}

/** Splits at a text position (caret < 0 or at an edge: in the middle). */
export function splitLine(lines: TextLine[], i: number, caret: number): TextLine[] {
  const l = lines[i];
  if (!l) return lines;
  const toks = tokens(l.text);
  if (toks.length < 2) return lines;
  let k = caret >= 0 ? tokens(l.text.slice(0, caret)).length : 0;
  if (k <= 0 || k >= toks.length) k = Math.ceil(toks.length / 2);
  const haveWords = l.words.length === toks.length;
  let cut: number;
  if (haveWords) {
    const a = l.words[k - 1] as TextWord;
    const b = l.words[k] as TextWord;
    cut = Math.round((a.endMs + b.startMs) / 2);
  } else {
    cut = Math.round(l.startMs + ((l.endMs - l.startMs) * k) / toks.length);
  }
  cut = Math.min(l.endMs, Math.max(l.startMs, cut));
  const firstWords = haveWords ? l.words.slice(0, k) : spread(toks.slice(0, k), l.startMs, cut);
  const secondWords = haveWords ? l.words.slice(k) : spread(toks.slice(k), cut, l.endMs);
  const first: TextLine = { startMs: l.startMs, endMs: cut, text: toks.slice(0, k).join(" "), words: clampWords(firstWords, l.startMs, cut) };
  const second: TextLine = { startMs: cut, endMs: l.endMs, text: toks.slice(k).join(" "), words: clampWords(secondWords, cut, l.endMs) };
  return [...lines.slice(0, i), first, second, ...lines.slice(i + 1)];
}

/** Joins a line with the next one. */
export function mergeNext(lines: TextLine[], i: number): TextLine[] {
  const a = lines[i];
  const b = lines[i + 1];
  if (!a || !b) return lines;
  const text = [a.text.trim(), b.text.trim()].filter(Boolean).join(" ");
  const merged: TextLine = { startMs: a.startMs, endMs: Math.max(a.endMs, b.endMs), text, words: [...a.words, ...b.words] };
  return [...lines.slice(0, i), merged, ...lines.slice(i + 2)];
}

/** Inserts an empty line after line i (i = -1: at `fallbackStartMs`), in the gap if there is room. */
export function insertAfter(lines: TextLine[], i: number, fallbackStartMs = 0): TextLine[] {
  const prev = lines[i];
  const next = lines[i + 1];
  const startMs = prev ? prev.endMs : Math.max(0, Math.round(fallbackStartMs));
  let endMs = startMs + NEW_LINE_MS;
  if (next && next.startMs - startMs >= MIN_LINE_MS) endMs = Math.min(endMs, next.startMs);
  return [...lines.slice(0, i + 1), { startMs, endMs, text: "", words: [] }, ...lines.slice(i + 1)];
}

export function deleteLine(lines: TextLine[], i: number): TextLine[] {
  return i >= 0 && i < lines.length ? lines.filter((_, k) => k !== i) : lines;
}

/** Edits a word's text; the line's text follows. */
export function setWordText(lines: TextLine[], i: number, w: number, text: string): TextLine[] {
  const l = lines[i];
  if (!l || !l.words[w]) return lines;
  const words = l.words.map((x, k) => (k === w ? { ...x, text } : x));
  return replace(lines, i, { ...l, words, text: joinWords(words) });
}

/** Moves a word's start and/or end (song ms), kept inside its line and in order. */
export function setWordTime(lines: TextLine[], i: number, w: number, t: { startMs?: number; endMs?: number }): TextLine[] {
  const l = lines[i];
  const cur = l?.words[w];
  if (!l || !cur) return lines;
  const startMs = Math.min(l.endMs, Math.max(l.startMs, Math.round(t.startMs ?? cur.startMs)));
  const endMs = Math.min(l.endMs, Math.max(startMs, Math.round(t.endMs ?? cur.endMs)));
  if (startMs === cur.startMs && endMs === cur.endMs) return lines;
  return replace(lines, i, { ...l, words: l.words.map((x, k) => (k === w ? { ...x, startMs, endMs } : x)) });
}

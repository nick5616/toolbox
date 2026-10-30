import type { CueWord } from "@/lib/api";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/** Words by whitespace, with every CJK character on its own (same rule as core/lyrics SplitWords). */
export function splitWords(text: string): string[] {
  const out: string[] = [];
  for (const f of text.split(/\s+/)) {
    if (f === "") continue;
    let cur = "";
    for (const ch of f) {
      if (CJK.test(ch)) {
        if (cur !== "") out.push(cur);
        cur = "";
        out.push(ch);
      } else cur += ch;
    }
    if (cur !== "") out.push(cur);
  }
  return out;
}

/** Gives text its words, sharing [startMs, endMs] by character count (core/lyrics SpreadWords). */
export function spreadWords(text: string, startMs: number, endMs: number): CueWord[] {
  const words = splitWords(text);
  if (words.length === 0) return [];
  const lens = words.map((w) => Math.max(1, Array.from(w).length));
  const total = lens.reduce((a, b) => a + b, 0);
  const span = endMs - startMs;
  let acc = 0;
  return words.map((w, i) => {
    const s = startMs + Math.floor((span * acc) / total);
    acc += lens[i] ?? 1;
    const e = startMs + Math.floor((span * acc) / total);
    return { startMs: s, endMs: e, text: w };
  });
}

/**
 * Moves words with their cue when it changes from [oldStart, oldEnd] to
 * [newStart, newEnd]: a pure shift when the length is unchanged, otherwise a
 * linear rescale (so trimming one edge keeps words inside the cue).
 */
export function moveWords(
  words: readonly CueWord[] | undefined,
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): CueWord[] | undefined {
  if (!words || words.length === 0) return undefined;
  const oldLen = oldEnd - oldStart;
  const newLen = newEnd - newStart;
  if (oldLen === newLen) {
    const d = newStart - oldStart;
    return words.map((w) => ({ ...w, startMs: w.startMs + d, endMs: w.endMs + d }));
  }
  const k = oldLen > 0 ? newLen / oldLen : 1;
  const at = (ms: number) => Math.round(newStart + (ms - oldStart) * k);
  return words.map((w) => ({ ...w, startMs: at(w.startMs), endMs: at(w.endMs) }));
}

/**
 * Splits words at time `at`. Words wholly before go left, wholly after go right.
 * When the split falls inside a word, both halves are re-spread from their text.
 */
export function splitWordsAt(
  words: readonly CueWord[] | undefined,
  at: number,
  left: { text: string; startMs: number; endMs: number },
  right: { text: string; startMs: number; endMs: number },
): [CueWord[] | undefined, CueWord[] | undefined] {
  if (!words || words.length === 0) return [undefined, undefined];
  if (words.some((w) => w.startMs < at && at < w.endMs)) {
    return [spreadWords(left.text, left.startMs, left.endMs), spreadWords(right.text, right.startMs, right.endMs)];
  }
  const l = words.filter((w) => w.endMs <= at);
  const r = words.filter((w) => w.endMs > at);
  return [l.length > 0 ? l : undefined, r.length > 0 ? r : undefined];
}

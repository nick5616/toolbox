export interface FuzzyMatch {
  score: number;
  /** Indices into `text` of the matched characters. */
  indices: number[];
}

const MAX_TEXT = 256;
const WORD_START = 8;
const CONSECUTIVE = 5;
const GAP = 1;
const LEADING = 0.1;
const NONE = Number.NEGATIVE_INFINITY;

function isWordStart(text: string, j: number): boolean {
  if (j === 0) return true;
  const prev = text.charAt(j - 1);
  const cur = text.charAt(j);
  if (!/[a-z0-9]/i.test(prev)) return true;
  return prev === prev.toLowerCase() && prev !== prev.toUpperCase() && cur !== cur.toLowerCase();
}

/**
 * Case-insensitive subsequence match. Returns the best-scoring alignment or
 * null when `query` is not a subsequence of `text`. Word starts and
 * consecutive runs score higher; gaps between matches are penalised.
 * An empty query matches everything with score 0.
 */
export function fuzzyScore(query: string, text: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (q.length === 0) return { score: 0, indices: [] };
  const t = text.slice(0, MAX_TEXT);
  const lower = t.toLowerCase();
  const n = t.length;
  const m = q.length;
  if (m > n) return null;

  // best[i][j]: best score with q[i] matched at text[j]; from[i][j]: previous index.
  const best: number[][] = [];
  const from: number[][] = [];
  for (let i = 0; i < m; i++) {
    const row: number[] = new Array<number>(n).fill(NONE);
    const prevIdx: number[] = new Array<number>(n).fill(-1);
    for (let j = i; j < n; j++) {
      if (lower.charAt(j) !== q.charAt(i)) continue;
      const bonus = 1 + (isWordStart(t, j) ? WORD_START : 0);
      if (i === 0) {
        row[j] = bonus - j * LEADING;
        continue;
      }
      const prevRow = best[i - 1]!;
      let top = NONE;
      let arg = -1;
      for (let k = i - 1; k < j; k++) {
        const p = prevRow[k]!;
        if (p === NONE) continue;
        const s = p + (k === j - 1 ? CONSECUTIVE : -GAP * (j - k - 1));
        if (s > top) {
          top = s;
          arg = k;
        }
      }
      if (arg >= 0) {
        row[j] = top + bonus;
        prevIdx[j] = arg;
      }
    }
    best.push(row);
    from.push(prevIdx);
  }

  const last = best[m - 1]!;
  let end = -1;
  let score = NONE;
  for (let j = 0; j < n; j++) {
    if (last[j]! > score) {
      score = last[j]!;
      end = j;
    }
  }
  if (end < 0) return null;
  const indices: number[] = new Array<number>(m);
  let j = end;
  for (let i = m - 1; i >= 0; i--) {
    indices[i] = j;
    j = from[i]![j]!;
  }
  return { score, indices };
}

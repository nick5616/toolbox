import type { PdfPageEdit } from "@/lib/api";

/** One output page of the organize grid; `page` (1-based source page) is also its identity. */
export interface Tile {
  page: number;
  /** Extra clockwise rotation: 0 | 90 | 180 | 270. */
  rotate: number;
}

export function initialTiles(pages: number): Tile[] {
  return Array.from({ length: Math.max(0, pages) }, (_, i) => ({ page: i + 1, rotate: 0 }));
}

export function rotateTiles(tiles: readonly Tile[], ids: ReadonlySet<number>, delta: number): Tile[] {
  return tiles.map((t) => (ids.has(t.page) ? { ...t, rotate: (((t.rotate + delta) % 360) + 360) % 360 } : t));
}

export function deleteTiles(tiles: readonly Tile[], ids: ReadonlySet<number>): Tile[] {
  return tiles.filter((t) => !ids.has(t.page));
}

export function keepOnly(tiles: readonly Tile[], ids: ReadonlySet<number>): Tile[] {
  return tiles.filter((t) => ids.has(t.page));
}

export function reverseTiles(tiles: readonly Tile[]): Tile[] {
  return tiles.slice().reverse();
}

/** Moves the tiles in `ids` one place left (-1) or right (1), keeping their relative order. */
export function moveBy(tiles: readonly Tile[], ids: ReadonlySet<number>, dir: -1 | 1): Tile[] {
  const out = tiles.slice();
  if (dir === -1) {
    for (let i = 1; i < out.length; i++) {
      const cur = out[i];
      const prev = out[i - 1];
      if (cur && prev && ids.has(cur.page) && !ids.has(prev.page)) {
        out[i - 1] = cur;
        out[i] = prev;
      }
    }
  } else {
    for (let i = out.length - 2; i >= 0; i--) {
      const cur = out[i];
      const next = out[i + 1];
      if (cur && next && ids.has(cur.page) && !ids.has(next.page)) {
        out[i + 1] = cur;
        out[i] = next;
      }
    }
  }
  return out;
}

/** Moves the tiles in `ids` so they sit together before the tile currently at `index` (tiles.length = end). */
export function moveToIndex(tiles: readonly Tile[], ids: ReadonlySet<number>, index: number): Tile[] {
  const moved = tiles.filter((t) => ids.has(t.page));
  if (moved.length === 0) return tiles.slice();
  const removedBefore = tiles.slice(0, index).filter((t) => ids.has(t.page)).length;
  const rest = tiles.filter((t) => !ids.has(t.page));
  const at = Math.max(0, Math.min(rest.length, index - removedBefore));
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}

/** Pages between two tiles inclusive, in grid order. */
export function rangeBetween(tiles: readonly Tile[], a: number, b: number): number[] {
  const i = tiles.findIndex((t) => t.page === a);
  const j = tiles.findIndex((t) => t.page === b);
  if (i < 0 || j < 0) return [b];
  const [lo, hi] = i < j ? [i, j] : [j, i];
  return tiles.slice(lo, hi + 1).map((t) => t.page);
}

/** "12 pages (3 removed, 2 rotated)". */
export function summarize(tiles: readonly Tile[], total: number): string {
  const removed = Math.max(0, total - tiles.length);
  const rotated = tiles.filter((t) => t.rotate % 360 !== 0).length;
  const parts: string[] = [];
  if (removed > 0) parts.push(`${removed} removed`);
  if (rotated > 0) parts.push(`${rotated} rotated`);
  const head = `${tiles.length} ${tiles.length === 1 ? "page" : "pages"}`;
  return parts.length > 0 ? `${head} (${parts.join(", ")})` : head;
}

export function toEdits(tiles: readonly Tile[]): PdfPageEdit[] {
  return tiles.map((t) => ({ page: t.page, rotate: t.rotate }));
}

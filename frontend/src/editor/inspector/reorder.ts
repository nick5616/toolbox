/** Pure helpers for dragging list items into a new order. */

/** A copy of `list` with the item at `from` moved so it ends up at index `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const t = Math.max(0, Math.min(out.length - 1, to));
  const [it] = out.splice(from, 1);
  out.splice(t, 0, it as T);
  return out;
}

/**
 * The index the dragged item should take for a pointer at `y`: the number of
 * other items whose vertical middle is above the pointer.
 */
export function targetIndex(rects: ReadonlyArray<{ top: number; height: number }>, from: number, y: number): number {
  let n = 0;
  for (const [i, r] of rects.entries()) {
    if (i === from) continue;
    if (r.top + r.height / 2 < y) n++;
  }
  return n;
}

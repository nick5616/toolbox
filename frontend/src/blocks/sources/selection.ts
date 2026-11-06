/** Selection helpers of the source grid (shared by Post Builder and the Sequence Editor). */
import type { PostSourceFile } from "@/lib/api";

/** The slide numbers a source is used on, ascending. */
export function usedNumbers(s: PostSourceFile, numbers: Readonly<Record<string, number>>): number[] {
  const out: number[] = [];
  for (const id of s.usedIn ?? []) {
    const n = numbers[id];
    if (n !== undefined) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/** Click / Shift+click / Mod+click selection over an ordered list of paths. */
export function clickSelection(
  order: readonly string[],
  current: ReadonlySet<string>,
  anchor: string,
  path: string,
  mods: { shift: boolean; toggle: boolean },
): { selected: Set<string>; anchor: string } {
  if (mods.shift && anchor && order.includes(anchor) && order.includes(path)) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(path);
    const next = mods.toggle ? new Set(current) : new Set<string>();
    for (const p of order.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(p);
    return { selected: next, anchor };
  }
  if (mods.toggle) {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return { selected: next, anchor: path };
  }
  return { selected: new Set([path]), anchor: path };
}

import type { PostSlide, PostSourceFile } from "@/lib/api";
import type { PostDoc } from "./logic";

// Pure logic of the source pool (SPEC.md §B13).

export type SourceSort = "taken" | "name";
export type SourceFilter = "all" | "photos" | "clips" | "unused";

export interface SourceView {
  sort: SourceSort;
  filter: SourceFilter;
  search: string;
}

export const DEFAULT_SOURCE_VIEW: SourceView = { sort: "taken", filter: "all", search: "" };

/** The sources as the grid shows them: filtered, searched by name, sorted. */
export function viewSources(sources: readonly PostSourceFile[], v: SourceView): PostSourceFile[] {
  const q = v.search.trim().toLowerCase();
  const out = sources.filter((s) => {
    if (v.filter === "photos" && s.kind !== "photo") return false;
    if (v.filter === "clips" && s.kind !== "clip") return false;
    if (v.filter === "unused" && (s.usedIn ?? []).length > 0) return false;
    return !q || s.name.toLowerCase().includes(q) || s.rel.toLowerCase().includes(q);
  });
  const byName = (a: PostSourceFile, b: PostSourceFile) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  out.sort(v.sort === "name" ? byName : (a, b) => a.takenAt - b.takenAt || byName(a, b));
  return out;
}

/** Slide ID → 1-based number. */
export function slideNumberMap(slides: readonly PostSlide[]): Record<string, number> {
  const m: Record<string, number> = {};
  slides.forEach((s, i) => {
    m[s.id] = i + 1;
  });
  return m;
}

/** The slide numbers a source is used in, ascending. */
export function usedNumbers(s: PostSourceFile, numbers: Readonly<Record<string, number>>): number[] {
  const out: number[] = [];
  for (const id of s.usedIn ?? []) {
    const n = numbers[id];
    if (n !== undefined) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/** The pool paths a slide uses (directly, or through its composition / video). */
export function slideSourcePaths(slide: PostSlide | undefined, sources: readonly PostSourceFile[]): Set<string> {
  const out = new Set<string>();
  if (!slide) return out;
  if ((slide.kind === "photo" || slide.kind === "clip") && slide.path) out.add(slide.path);
  for (const s of sources) if ((s.usedIn ?? []).includes(slide.id)) out.add(s.path);
  return out;
}

/** Click selection: plain replaces, Ctrl/Cmd toggles, Shift selects from the anchor. */
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

/** What a source drop on the slides strip does. */
export type StripDrop = { kind: "replace"; index: number } | { kind: "insert"; index: number };

/**
 * Hit-tests a drop at y against the strip's tiles (top/bottom per tile, in
 * order): the middle half of a photo or clip tile replaces its source; any
 * other spot inserts before the first tile whose centre is below y.
 */
export function stripDrop(rects: readonly { top: number; bottom: number }[], kinds: readonly string[], y: number): StripDrop {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    const h = r.bottom - r.top;
    if (y >= r.top + h * 0.25 && y <= r.bottom - h * 0.25 && (kinds[i] === "photo" || kinds[i] === "clip")) return { kind: "replace", index: i };
  }
  let idx = rects.length;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (y < (r.top + r.bottom) / 2) {
      idx = i;
      break;
    }
  }
  return { kind: "insert", index: idx };
}

/** Inserts items at an index (clamped). */
export function insertAt<T>(list: readonly T[], index: number, items: readonly T[]): T[] {
  const i = Math.min(Math.max(index, 0), list.length);
  return [...list.slice(0, i), ...items, ...list.slice(i)];
}

/** Hides pool sources: folder files go to Hidden, extras are dropped from Extra. */
export function hideFromPool(doc: Pick<PostDoc, "extra" | "hidden">, sources: readonly PostSourceFile[], paths: readonly string[]): { extra: string[]; hidden: string[] } {
  const drop = new Set(paths);
  const extras = new Set(sources.filter((s) => s.rel === "" && drop.has(s.path)).map((s) => s.path));
  const hidden = [...doc.hidden];
  for (const p of paths) if (!extras.has(p) && !hidden.includes(p)) hidden.push(p);
  return { extra: doc.extra.filter((p) => !extras.has(p)), hidden };
}

/** Adds extra sources (deduplicated, in order). */
export function addExtras(extra: readonly string[], paths: readonly string[]): string[] {
  const out = [...extra];
  for (const p of paths) if (!out.includes(p)) out.push(p);
  return out;
}

/** Everything that changes which sources exist or where they are used. */
export function poolSignature(doc: PostDoc): string {
  const slides = doc.slides.map((s) => `${s.id}:${s.kind}:${s.path}:${s.projectId}`).join(",");
  return JSON.stringify([doc.folder, doc.subfolders, doc.extra, doc.hidden, slides]);
}

/** The last segment of a folder path. */
export function folderBaseName(folder: string): string {
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** The base name of a path. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export const AUDIO_EXTS = [".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus"];

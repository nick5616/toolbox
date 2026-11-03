/** Pure helpers of the Sources panel (Phase 9 SPEC §14.6): tags, filtering, used counts, relinking, adding. */
import type { EditSource } from "@/lib/api";
import type { NormalProject } from "@/viz/edit/defaults";

export const TAG_PRESETS = ["hero", "closeup", "wide", "broll"] as const;
export const MAX_TAGS = 8;
export const MAX_TAG_LEN = 24;
export const MAX_SOURCES = 300;

/** A tag as stored: lower-case, 1..24 chars of letters, digits, "-" and "_" (spaces become "-"); null when nothing is left. */
export function normalizeTag(raw: string): string | null {
  const t = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .slice(0, MAX_TAG_LEN);
  return t === "" ? null : t;
}

/** The tags with `tag` toggled; null when adding would pass 8 tags. */
export function toggleTag(tags: readonly string[], tag: string): string[] | null {
  if (tags.includes(tag)) return tags.filter((t) => t !== tag);
  return tags.length >= MAX_TAGS ? null : [...tags, tag];
}

/** Sets one source's tags. */
export function setSourceTags(doc: NormalProject, path: string, tags: string[]): NormalProject {
  let changed = false;
  const sources = doc.sources.map((s) => {
    if (s.path !== path) return s;
    changed = true;
    return { ...s, tags };
  });
  return changed ? { ...doc, sources } : doc;
}

/** Every tag in use, presets first. */
export function allTags(sources: readonly EditSource[]): string[] {
  const custom = new Set<string>();
  for (const s of sources) for (const t of s.tags ?? []) if (!(TAG_PRESETS as readonly string[]).includes(t)) custom.add(t);
  return [...TAG_PRESETS, ...[...custom].sort()];
}

/** Sources having any of the filter tags (all when the filter is empty). */
export function filterSources<T extends EditSource>(sources: readonly T[], filter: readonly string[]): T[] {
  if (!filter.length) return [...sources];
  return sources.filter((s) => (s.tags ?? []).some((t) => filter.includes(t)));
}

/** How many clips use each source path. */
export function usedCounts(doc: NormalProject): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of doc.tracks) for (const c of t.clips) if (c.path) out.set(c.path, (out.get(c.path) ?? 0) + 1);
  return out;
}

/** Adds paths to Sources (deduplicated, ≤ 300). Returns the new project and the paths that were actually added. */
export function appendSources(doc: NormalProject, paths: readonly string[]): { project: NormalProject; added: string[] } {
  const have = new Set(doc.sources.map((s) => s.path));
  const added: string[] = [];
  for (const p of paths) {
    if (have.has(p) || doc.sources.length + added.length >= MAX_SOURCES) continue;
    have.add(p);
    added.push(p);
  }
  if (!added.length) return { project: doc, added };
  return { project: { ...doc, sources: [...doc.sources, ...added.map((path) => ({ path, tags: [] }))] }, added };
}

/** Replaces a file path in the Sources list and in every clip (relinking a moved file). */
export function relinkPath(doc: NormalProject, from: string, to: string): NormalProject {
  if (from === to) return doc;
  let changed = false;
  const target = doc.sources.find((s) => s.path === to);
  const sources: NormalProject["sources"] = [];
  for (const s of doc.sources) {
    if (s.path !== from) {
      sources.push(s);
      continue;
    }
    changed = true;
    if (target) continue; // already listed: merge below
    sources.push({ ...s, path: to });
  }
  if (target) {
    const moved = doc.sources.find((s) => s.path === from);
    const merged = [...new Set([...(target.tags ?? []), ...(moved?.tags ?? [])])].slice(0, MAX_TAGS);
    const i = sources.findIndex((s) => s.path === to);
    if (i >= 0) sources[i] = { ...target, tags: merged };
  }
  const tracks = doc.tracks.map((t) => {
    if (!t.clips.some((c) => c.path === from)) return t;
    changed = true;
    return { ...t, clips: t.clips.map((c) => (c.path === from ? { ...c, path: to } : c)) };
  });
  return changed ? { ...doc, sources, tracks } : doc;
}

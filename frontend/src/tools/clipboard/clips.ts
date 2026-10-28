import { ClipKind, type ClipItem } from "@/lib/api";

export type KindFilter = "all" | "text" | "image";

/** Pinned first, then most recently used. */
export function compareClips(a: ClipItem, b: ClipItem): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return b.lastUsedAt - a.lastUsedAt;
}

export function sortClips(items: readonly ClipItem[]): ClipItem[] {
  return [...items].sort(compareClips);
}

/** Inserts or replaces by id, keeping the list sorted. */
export function upsertClip(items: readonly ClipItem[], item: ClipItem): ClipItem[] {
  return sortClips([...items.filter((i) => i.id !== item.id), item]);
}

export function removeClips(items: readonly ClipItem[], ids: readonly string[]): ClipItem[] {
  if (ids.length === 0) return items.slice();
  const drop = new Set(ids);
  return items.filter((i) => !drop.has(i.id));
}

export function kindToClipKind(k: KindFilter): ClipKind {
  return k === "text" ? ClipKind.ClipText : k === "image" ? ClipKind.ClipImage : ClipKind.$zero;
}

/** Whether a live item belongs in the list for the current filters (mirrors the server query). */
export function matchesFilters(item: ClipItem, search: string, kind: KindFilter): boolean {
  if (kind === "text" && item.kind !== ClipKind.ClipText) return false;
  if (kind === "image" && item.kind !== ClipKind.ClipImage) return false;
  const q = search.trim().toLowerCase();
  return q === "" || item.preview.toLowerCase().includes(q);
}

export function charCount(item: ClipItem): number {
  return item.text ? item.text.length : item.preview.length;
}

/** Short accessible name; never the full clipboard text. */
export function clipLabel(item: ClipItem): string {
  if (item.kind === ClipKind.ClipImage) return `Image ${item.width} by ${item.height}`;
  const p = item.preview.trim();
  return p.length > 60 ? `${p.slice(0, 60)}…` : p || "Empty text";
}

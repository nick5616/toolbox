/**
 * A grid of design cards with live thumbnails reacting to the file (SPEC.md
 * §8.3, §9.1): one hidden Engine renders each visible card at 320×180 at
 * `timeMs` every 500 ms. CONTRACT (foundation): VP1 implements it; the
 * designer's Presets tab and the VisualsPicker use it.
 */
import type { Analysis } from "@/viz/analysis";
import type { Show } from "@/viz/types";

export interface ThumbItem {
  id: string;
  name: string;
  description: string;
  show: Show;
  /** "mine" = a saved design, shown first with a badge. */
  kind: "preset" | "mine" | "custom";
}

export interface PresetThumbsProps {
  items: ThumbItem[];
  analysis: Analysis | null;
  /** The time the thumbnails show; null = loop the loudest 8 s. */
  timeMs: number | null;
  aspect: number;
  mode: "opaque" | "overlay";
  selectedId: string | null;
  onSelect(item: ThumbItem): void;
  /** Card menu for saved designs (rename/delete); omitted = no menu. */
  onRename?(item: ThumbItem, name: string): void;
  onDelete?(item: ThumbItem): void;
  className?: string;
}

export function PresetThumbs(_props: PresetThumbsProps) {
  return null; // VP1
}

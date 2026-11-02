import type { PostSourceFile } from "@/lib/api";

// The grid of a post's source pool (SPEC.md §B13.4), shared by Post Builder,
// Photo Composer and Video Editor. FROZEN props (Wave C0); WP-PB3 implements
// it (lazy thumbnails, multi-select, usage badges, dragging out via
// startSourceDrag). The stub lists names.

export interface SourceGridProps {
  sources: PostSourceFile[];
  /** Selected paths. */
  selected: ReadonlySet<string>;
  onSelectionChange: (next: Set<string>) => void;
  /** Paths to highlight (used by the selected slide). */
  highlighted?: ReadonlySet<string>;
  /** Slide ID → 1-based slide number, for "used in 2, 5" badges. */
  slideNumbers?: Readonly<Record<string, number>>;
  /** Double-click or Enter on a source. */
  onActivate?: (path: string) => void;
  /** Allow dragging selected sources out (startSourceDrag). Default true. */
  draggable?: boolean;
  /** Tile edge in px (default 96). */
  tileSize?: number;
  /** Shown when there are no sources. */
  emptyLabel?: string;
}

export function SourceGrid({ sources, emptyLabel }: SourceGridProps) {
  if (sources.length === 0) return <p>{emptyLabel ?? "No sources"}</p>;
  return (
    <ul aria-label="Sources">
      {sources.map((s) => (
        <li key={s.path}>{s.name}</li>
      ))}
    </ul>
  );
}

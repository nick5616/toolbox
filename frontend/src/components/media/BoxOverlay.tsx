import type { Box, ContentRect } from "./types";

export interface BoxOverlayProps {
  rect: ContentRect;
  boxes: Box[];
  onChange?: (boxes: Box[]) => void;
  editable?: boolean;
  /** When true, dragging on an empty area draws a new manual box. */
  drawMode?: boolean;
  selectedId?: string;
  onSelect?: (id: string | undefined) => void;
  /** Optional per-box fill preview (e.g. the redaction effect), drawn under the outline. */
  renderFill?: (box: Box) => React.ReactNode;
}

/** Selectable, toggleable, resizable boxes over a picture (SPEC.md §3.11). UI-M implements it. */
export function BoxOverlay(_props: BoxOverlayProps) {
  return null;
}

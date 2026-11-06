/**
 * Parts: the constituent pieces of composed tools (Phase 10, SPEC.md §4.3).
 * FOUNDATION CONTRACT (WP-W1 implements the registry and PartFrame; any
 * package may define parts with `definePart`).
 *
 * A part is a component that can render inline in its host tool or in its
 * own window. Inline, it is wrapped in a <PartFrame> with a pop-out button.
 * Popped out, the host shows a placeholder ("Open in its own window · Bring
 * back") and the part renders in a part window (`?window=part&part=<id>`),
 * where it reads and changes the host's state through a store bridge
 * (state/bridge.ts) over `windows:relay`.
 */
import type { ComponentType, LazyExoticComponent } from "react";

export interface PartSpec {
  /** "<moduleId>.<name>", e.g. "edit-studio.preview". [a-z0-9.-] */
  id: string;
  /** Module whose tool hosts it (its store, its bridge). */
  host: string;
  title: string;
  icon: string;
  /** One line for tooltips. */
  tip: string;
  /** Default pop-out window size. */
  width: number;
  height: number;
  /**
   * The part's UI. Inline it gets `{ placement: "inline" }`; in its own
   * window `{ placement: "window" }` (the part window bootstraps the host's
   * replica store first, via `connect`).
   */
  component: LazyExoticComponent<ComponentType<PartProps>> | ComponentType<PartProps>;
  /**
   * Part windows only: connect this window to its host before rendering
   * (start the store replica, load what the part needs). Returns a cleanup.
   */
  connect?: (params: URLSearchParams) => Promise<() => void>;
  /** A title/icon that depends on the window's parameters (e.g. which panel). */
  headingFor?: (params: URLSearchParams) => { title: string; icon: string } | null;
}

export interface PartProps {
  placement: "inline" | "window";
}

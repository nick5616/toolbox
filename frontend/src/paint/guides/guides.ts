// Guides: the document's guide settings (stored as JSON in PaintDoc.guides),
// the 2D grid, perspective (1–3 vanishing points) and isometric drawing assist.

import type { Point } from "../engine/types";
import { NO_SYMMETRY, type SymmetryConfig } from "./symmetry";

export interface GridConfig {
  on: boolean;
  /** Cell size in canvas px. */
  size: number;
  snap: boolean;
}

export interface PerspectiveConfig {
  points: 0 | 1 | 2 | 3;
  /** Vanishing points in canvas px (as many as `points`). */
  vps: Point[];
  assist: boolean;
}

export interface IsoConfig {
  on: boolean;
  assist: boolean;
}

export interface GuidesConfig {
  symmetry: SymmetryConfig;
  grid: GridConfig;
  perspective: PerspectiveConfig;
  iso: IsoConfig;
}

export function defaultGuides(): GuidesConfig {
  return {
    symmetry: { ...NO_SYMMETRY },
    grid: { on: false, size: 64, snap: false },
    perspective: { points: 0, vps: [], assist: false },
    iso: { on: false, assist: false },
  };
}

export function parseGuides(json: string): GuidesConfig {
  const d = defaultGuides();
  if (!json) return d;
  try {
    const o = JSON.parse(json) as Partial<GuidesConfig>;
    return {
      symmetry: { ...d.symmetry, ...(o.symmetry ?? {}) },
      grid: { ...d.grid, ...(o.grid ?? {}) },
      perspective: { ...d.perspective, ...(o.perspective ?? {}) },
      iso: { ...d.iso, ...(o.iso ?? {}) },
    };
  } catch {
    return d;
  }
}

export function stringifyGuides(g: GuidesConfig): string {
  const isDefault = g.symmetry.mode === "off" && !g.grid.on && g.perspective.points === 0 && !g.iso.on;
  return isDefault ? "" : JSON.stringify(g);
}

// ---- grid ----

export function snapToGrid(g: GridConfig, p: Point): Point {
  if (!g.snap || g.size <= 0) return p;
  return { x: Math.round(p.x / g.size) * g.size, y: Math.round(p.y / g.size) * g.size };
}

/** Grid line coordinates inside a canvas-space rect (for overlays). */
export function gridLines(g: GridConfig, r: { x: number; y: number; w: number; h: number }): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  if (!g.on || g.size < 2) return { xs, ys };
  for (let x = Math.ceil(r.x / g.size) * g.size; x <= r.x + r.w; x += g.size) xs.push(x);
  for (let y = Math.ceil(r.y / g.size) * g.size; y <= r.y + r.h; y += g.size) ys.push(y);
  return { xs, ys };
}

// ---- perspective / isometric assist ----

/** Directions (unit vectors) a stroke starting at `start` may snap to. */
export function assistDirections(g: GuidesConfig, start: Point): Point[] {
  const out: Point[] = [];
  if (g.perspective.assist) {
    for (const vp of g.perspective.vps.slice(0, g.perspective.points)) {
      const dx = vp.x - start.x;
      const dy = vp.y - start.y;
      const l = Math.hypot(dx, dy);
      if (l > 1e-6) out.push({ x: dx / l, y: dy / l });
    }
  }
  if (g.iso.on && g.iso.assist) {
    const c = Math.cos(Math.PI / 6);
    out.push({ x: 0, y: 1 }, { x: c, y: 0.5 }, { x: c, y: -0.5 });
  }
  return out;
}

export const assistActive = (g: GuidesConfig): boolean => (g.perspective.assist && g.perspective.points > 0) || (g.iso.on && g.iso.assist);

/** Locks a stroke onto the guide line nearest its first movement and projects the rest. */
export class LineAssist {
  private start: Point | null = null;
  private dirs: Point[] = [];
  private dir: Point | null = null;
  constructor(private readonly g: GuidesConfig) {}

  begin(p: Point): void {
    this.start = { x: p.x, y: p.y };
    this.dirs = assistDirections(this.g, p);
    this.dir = null;
  }

  /** Writes the constrained position into out. */
  map(x: number, y: number, out: Point): void {
    const s = this.start;
    if (!s || this.dirs.length === 0) {
      out.x = x;
      out.y = y;
      return;
    }
    const dx = x - s.x;
    const dy = y - s.y;
    if (!this.dir) {
      const l = Math.hypot(dx, dy);
      if (l < 8) {
        out.x = x;
        out.y = y;
        return;
      }
      let best = 0;
      let bestDot = -1;
      for (let i = 0; i < this.dirs.length; i++) {
        const d = this.dirs[i] as Point;
        const dot = Math.abs((d.x * dx + d.y * dy) / l);
        if (dot > bestDot) {
          bestDot = dot;
          best = i;
        }
      }
      this.dir = this.dirs[best] as Point;
    }
    const t = this.dir.x * dx + this.dir.y * dy;
    out.x = s.x + this.dir.x * t;
    out.y = s.y + this.dir.y * t;
  }
}
